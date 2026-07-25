import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { ShareLink, ShareLinkType } from '../enrollment/entities/share-link.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import {
  AcceptCoachInviteDto,
  CoachInvitationStatus,
  CoachInvitationView,
  CoachView,
  InviteCoachDto,
  ResolvedCoachInviteView,
} from './dto/coach.dto';
import { CoachProfile } from './entities/coach-profile.entity';

/** Unique coach invites expire after 7 days and are single-use (US-01.08). */
const COACH_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class CoachesService {
  constructor(
    @InjectRepository(CoachProfile) private readonly coaches: Repository<CoachProfile>,
    private readonly dataSource: DataSource,
    private readonly trainersService: TrainersService,
    private readonly shareLinks: ShareLinksService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    private readonly clock: ClockService,
  ) {}

  async invite(principal: Principal, dto: InviteCoachDto): Promise<CoachInvitationView> {
    const trainer = await this.requireTrainer(principal.userId);

    const link = await this.shareLinks.create({
      trainerProfileId: trainer.id,
      type: ShareLinkType.CoachUnique,
      createdByUserId: principal.userId,
      targetEmail: dto.email,
      expiresAt: new Date(this.clock.now().getTime() + COACH_INVITE_TTL_MS),
      maxUses: 1,
    });

    await this.mail.sendCoachInviteEmail(dto.email, trainer.businessName, link.code, dto.message);
    return this.toInvitationView(link);
  }

  async listInvitations(principal: Principal): Promise<CoachInvitationView[]> {
    const trainer = await this.requireTrainer(principal.userId);
    const links = (await this.shareLinks.findByTrainer(trainer.id)).filter(
      (l) => l.type === ShareLinkType.CoachUnique,
    );
    return links.map((l) => this.toInvitationView(l));
  }

  async listCoaches(principal: Principal): Promise<CoachView[]> {
    const trainer = await this.requireTrainer(principal.userId);
    const profiles = await this.coaches.find({
      where: { trainerProfileId: trainer.id },
      order: { joinedAt: 'DESC' },
    });
    const users = await this.usersService.findByIds(profiles.map((p) => p.userId));
    const userById = new Map(users.map((u) => [u.id, u]));
    return profiles.map((p) => {
      const u = userById.get(p.userId);
      return {
        id: p.id,
        userId: p.userId,
        email: u?.email ?? 'unknown',
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        bio: p.bio,
        publicVisible: p.publicVisible,
        joinedAt: p.joinedAt,
      };
    });
  }

  async resolve(code: string): Promise<ResolvedCoachInviteView> {
    const link = await this.shareLinks.findByCode(code);
    if (!link || !link.active || link.type !== ShareLinkType.CoachUnique) {
      return { valid: false, email: null, trainerName: null };
    }
    const usable =
      (link.expiresAt === null || link.expiresAt.getTime() > this.clock.now().getTime()) &&
      (link.maxUses === null || link.useCount < link.maxUses);
    const trainer = await this.trainersService.findById(link.trainerProfileId);
    return {
      valid: usable,
      email: link.targetEmail,
      trainerName: trainer?.businessName ?? null,
    };
  }

  /** New coach accepts an invite: creates the Coach account + profile. */
  async accept(code: string, dto: AcceptCoachInviteDto): Promise<{ message: string }> {
    let verificationToken = '';
    const user = await this.dataSource.transaction(async (manager: EntityManager) => {
      // Locked inside the transaction so two people cannot accept the same
      // single-use invite concurrently.
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.CoachUnique,
        manager,
      );
      if (!link.targetEmail) {
        throw new NotFoundException({
          errorCode: ErrorCode.SHARE_LINK_INVALID,
          message: 'This coaching invite is invalid.',
        });
      }

      const email = link.targetEmail;
      const existing = await this.usersService.findByEmail(email);
      if (existing) {
        // A coach can be active under only one trainer; existing accounts must
        // be handled by support rather than silently re-homed.
        throw new ConflictException({
          errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
          message: 'An account with this email already exists. Contact support to switch trainers.',
        });
      }

      const created = await this.authService.createUnverifiedAccount(
        {
          email,
          password: dto.password,
          role: Role.Coach,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
        manager,
      );
      verificationToken = created.verificationToken;

      const coachRepo = manager.getRepository(CoachProfile);
      await coachRepo.save(
        coachRepo.create({
          userId: created.user.id,
          trainerProfileId: link.trainerProfileId,
          publicVisible: false,
          joinedAt: this.clock.now(),
        }),
      );

      await this.shareLinks.incrementUse(link.id, manager);
      return created.user;
    });

    await this.mail.sendVerificationEmail(user.email, verificationToken);
    return { message: 'Coach account created. Verify your email to finish joining.' };
  }

  private toInvitationView(link: ShareLink): CoachInvitationView {
    return {
      id: link.id,
      code: link.code,
      email: link.targetEmail ?? '',
      status: this.statusOf(link),
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
    };
  }

  private statusOf(link: ShareLink): CoachInvitationStatus {
    if (link.useCount >= 1) {
      return 'accepted';
    }
    const expired =
      !link.active ||
      (link.expiresAt !== null && link.expiresAt.getTime() <= this.clock.now().getTime());
    return expired ? 'expired' : 'pending';
  }

  private async requireTrainer(userId: string): Promise<{ id: string; businessName: string }> {
    const trainer = await this.trainersService.findByUserId(userId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return { id: trainer.id, businessName: trainer.businessName };
  }
}
