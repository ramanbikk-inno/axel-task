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
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { ShareLink, ShareLinkType } from '../enrollment/entities/share-link.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
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
import { CoachProfile, CoachStatus } from './entities/coach-profile.entity';

/** Unique coach invites expire after 7 days and are single-use (US-01.08). */
const COACH_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUDIT_COACH_INVITED = 'coach.invited';
export const AUDIT_COACH_INVITE_RESENT = 'coach.invite-resent';
export const AUDIT_COACH_INVITE_REVOKED = 'coach.invite-revoked';
export const AUDIT_COACH_OFFBOARDED = 'coach.offboarded';
export const AUDIT_COACH_JOINED = 'coach.joined';

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
    private readonly audit: AuditService,
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
    await this.audit.record({
      action: AUDIT_COACH_INVITED,
      actor: principal,
      target: { type: 'ShareLink', id: link.id },
      metadata: { email: dto.email },
    });
    return this.toInvitationView(link);
  }

  async listInvitations(principal: Principal): Promise<CoachInvitationView[]> {
    const trainer = await this.requireTrainer(principal.userId);
    const links = (await this.shareLinks.findByTrainer(trainer.id)).filter(
      (l) => l.type === ShareLinkType.CoachUnique,
    );
    return links.map((l) => this.toInvitationView(l));
  }

  /**
   * Re-send a pending invitation (US-01.08: "Link expires: Clear message,
   * option to resend invitation").
   *
   * The old link is deactivated and a new code minted rather than the expiry
   * extended: the original may have gone to a mailbox the trainer no longer
   * intends to reach, and a code that keeps coming back to life is one that
   * can never be taken away.
   */
  async resendInvitation(principal: Principal, invitationId: string): Promise<CoachInvitationView> {
    const trainer = await this.requireTrainer(principal.userId);
    const existing = await this.requireOwnInvitation(trainer.id, invitationId);

    if (existing.useCount >= 1) {
      throw new ConflictException({
        errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED,
        message: 'This invitation has already been accepted.',
      });
    }
    if (!existing.targetEmail) {
      throw new ConflictException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This invitation has no recipient to resend to.',
      });
    }

    const email = existing.targetEmail;
    const replacement = await this.dataSource.transaction(async (manager: EntityManager) => {
      await this.shareLinks.deactivate(existing.id, manager);
      return this.shareLinks.create(
        {
          trainerProfileId: trainer.id,
          type: ShareLinkType.CoachUnique,
          createdByUserId: principal.userId,
          targetEmail: email,
          expiresAt: new Date(this.clock.now().getTime() + COACH_INVITE_TTL_MS),
          maxUses: 1,
        },
        manager,
      );
    });

    await this.mail.sendCoachInviteEmail(email, trainer.businessName, replacement.code);
    await this.audit.record({
      action: AUDIT_COACH_INVITE_RESENT,
      actor: principal,
      target: { type: 'ShareLink', id: replacement.id },
      metadata: { email, replaced: existing.id },
    });
    return this.toInvitationView(replacement);
  }

  /**
   * Cancel a pending invitation. A single-use link that reached the wrong
   * mailbox is live for seven days and grants a Coach account inside the
   * trainer's org; there has to be a way to take it back.
   */
  async revokeInvitation(principal: Principal, invitationId: string): Promise<CoachInvitationView> {
    const trainer = await this.requireTrainer(principal.userId);
    const existing = await this.requireOwnInvitation(trainer.id, invitationId);

    if (existing.useCount >= 1) {
      throw new ConflictException({
        errorCode: ErrorCode.INVITATION_ALREADY_ACCEPTED,
        message: 'This invitation has already been accepted and cannot be revoked.',
      });
    }

    await this.shareLinks.deactivate(existing.id);
    await this.audit.record({
      action: AUDIT_COACH_INVITE_REVOKED,
      actor: principal,
      target: { type: 'ShareLink', id: existing.id },
      metadata: { email: existing.targetEmail },
    });
    return this.toInvitationView(await this.requireOwnInvitation(trainer.id, invitationId));
  }

  /**
   * End a coach's engagement (US-01.08's lifecycle counterpart).
   *
   * The row is kept and marked Inactive rather than deleted, so the engagement
   * stays in the record and the partial unique index frees the coach to be
   * hired elsewhere. Their sessions are revoked immediately: their tenancy
   * comes from this row, and leaving a live token behind would let them keep
   * reading the org's roster until it expired.
   */
  async offboardCoach(principal: Principal, coachProfileId: string): Promise<CoachView> {
    const trainer = await this.requireTrainer(principal.userId);
    const profile = await this.coaches.findOne({
      // The trainer clause is the tenancy boundary: without it a trainer could
      // off-board another organisation's coach by id.
      where: { id: coachProfileId, trainerProfileId: trainer.id },
    });
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        message: 'Coach not found in your organization.',
      });
    }
    if (profile.status !== CoachStatus.Active) {
      throw new ConflictException({
        errorCode: ErrorCode.COACH_ALREADY_INACTIVE,
        message: 'This coach has already been off-boarded.',
      });
    }

    const now = this.clock.now();
    await this.coaches.update({ id: profile.id }, { status: CoachStatus.Inactive, endedAt: now });
    await this.authService.revokeAllUserSessions(profile.userId, 'coach-offboarded');
    await this.audit.record({
      action: AUDIT_COACH_OFFBOARDED,
      actor: principal,
      targetUserId: profile.userId,
      target: { type: 'CoachProfile', id: profile.id },
    });

    const [view] = await this.buildCoachViews([
      { ...profile, status: CoachStatus.Inactive, endedAt: now },
    ]);
    return view;
  }

  async listCoaches(principal: Principal, includeInactive = false): Promise<CoachView[]> {
    const trainer = await this.requireTrainer(principal.userId);
    const profiles = await this.coaches.find({
      where: includeInactive
        ? { trainerProfileId: trainer.id }
        : { trainerProfileId: trainer.id, status: CoachStatus.Active },
      order: { joinedAt: 'DESC' },
    });
    return this.buildCoachViews(profiles);
  }

  private async buildCoachViews(profiles: CoachProfile[]): Promise<CoachView[]> {
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
        status: p.status,
        joinedAt: p.joinedAt,
        endedAt: p.endedAt,
      };
    });
  }

  private async requireOwnInvitation(
    trainerProfileId: string,
    invitationId: string,
  ): Promise<ShareLink> {
    const link = await this.shareLinks.findById(invitationId);
    // Type and owner are both part of the lookup: a trainer must not be able
    // to reach a player link, or another org's invite, through this route.
    if (
      !link ||
      link.trainerProfileId !== trainerProfileId ||
      link.type !== ShareLinkType.CoachUnique
    ) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Invitation not found.',
      });
    }
    return link;
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
        return this.attachExistingCoach(existing, link.trainerProfileId, link.id, manager);
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

    if (verificationToken === '') {
      // An existing account was re-homed; there is nothing new to verify.
      return { message: 'You have joined this trainer. Sign in as usual.' };
    }
    await this.mail.sendVerificationEmail(user.email, verificationToken);
    return { message: 'Coach account created. Verify your email to finish joining.' };
  }

  /**
   * Attach an existing account to this trainer.
   *
   * US-01.08 says a coach "can ONLY be active under this trainer" — a rule
   * about *current* employment. Before, any existing email was refused
   * outright with "contact support", which also blocked the ordinary case of a
   * coach whose previous engagement has ended being hired again. What must
   * stay impossible is poaching someone who is still active elsewhere, and the
   * partial unique index enforces that in the database as well as here.
   */
  private async attachExistingCoach(
    existing: User,
    trainerProfileId: string,
    linkId: string,
    manager: EntityManager,
  ): Promise<User> {
    if (existing.role !== Role.Coach) {
      // A parent or trainer account cannot quietly become a coach: their
      // existing data and permissions are shaped by the role they have.
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists and is not a coach account.',
      });
    }

    const coachRepo = manager.getRepository(CoachProfile);
    const active = await coachRepo.findOne({
      where: { userId: existing.id, status: CoachStatus.Active },
    });
    if (active) {
      throw new ConflictException({
        errorCode:
          active.trainerProfileId === trainerProfileId
            ? ErrorCode.EMAIL_ALREADY_EXISTS
            : ErrorCode.COACH_ACTIVE_ELSEWHERE,
        message:
          active.trainerProfileId === trainerProfileId
            ? 'This coach is already active in your organization.'
            : 'This coach is currently active with another trainer and must be off-boarded first.',
      });
    }

    await coachRepo.save(
      coachRepo.create({
        userId: existing.id,
        trainerProfileId,
        publicVisible: false,
        status: CoachStatus.Active,
        joinedAt: this.clock.now(),
        endedAt: null,
      }),
    );
    await this.shareLinks.incrementUse(linkId, manager);
    return existing;
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
