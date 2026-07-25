import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { MailService } from '../mail/mail.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AssociationsService } from './associations.service';
import { JoinRegisterDto } from './dto/join-register.dto';
import { ShareLink, ShareLinkType } from './entities/share-link.entity';
import { ShareLinksService } from './share-links.service';

export interface ResolvedShareLink {
  code: string;
  valid: boolean;
  trainer: { profileId: string; businessName: string } | null;
}

export interface JoinResult {
  message: string;
  associationId: string;
  trainerProfileId: string;
  playerProfileId: string;
}

function displayNameFor(
  input: { firstName?: string | null; lastName?: string | null },
  fallback: string,
): string {
  const full = [input.firstName, input.lastName]
    .filter((v) => v !== null && v !== undefined && v.trim() !== '')
    .join(' ');
  return full !== '' ? full : fallback;
}

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly playersService: PlayersService,
    private readonly trainersService: TrainersService,
    private readonly shareLinks: ShareLinksService,
    private readonly associations: AssociationsService,
    private readonly mail: MailService,
    private readonly clock: ClockService,
  ) {}

  /** Public: resolve a ShareLink for the join page (trainer name + validity). */
  async resolve(code: string): Promise<ResolvedShareLink> {
    const link = await this.shareLinks.findByCode(code);
    // A coach invite is not a player join code; the join page must not preview
    // one, let alone name the trainer behind it.
    if (!link || !link.active || link.type !== ShareLinkType.PlayerStatic) {
      return { code, valid: false, trainer: null };
    }
    const usable =
      (link.expiresAt === null || link.expiresAt.getTime() > this.clock.now().getTime()) &&
      (link.maxUses === null || link.useCount < link.maxUses);
    const profile = await this.trainersService.findById(link.trainerProfileId);
    return {
      code,
      valid: usable,
      trainer: profile ? { profileId: profile.id, businessName: profile.businessName } : null,
    };
  }

  /**
   * Generate a static player ShareLink for the calling trainer (US-01.02).
   *
   * Player links only. Coach invites are single-use, 7-day and bound to a
   * target email, all of which this endpoint would leave unset — minting one
   * here produced a "coach invite" that never expires and never runs out.
   * They belong to POST /coaches/invitations (US-01.08).
   */
  async createTrainerShareLink(principal: Principal): Promise<ShareLink> {
    const trainerProfile = await this.trainersService.findByUserId(principal.userId);
    if (!trainerProfile) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return this.shareLinks.create({
      trainerProfileId: trainerProfile.id,
      type: ShareLinkType.PlayerStatic,
      createdByUserId: principal.userId,
    });
  }

  async listTrainerShareLinks(principal: Principal): Promise<ShareLink[]> {
    const trainerProfile = await this.trainersService.findByUserId(principal.userId);
    if (!trainerProfile) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return this.shareLinks.findByTrainer(trainerProfile.id);
  }

  /**
   * New player/parent registers via a trainer's ShareLink: creates the account
   * + self player profile + trainer association, then emails verification and a
   * join confirmation.
   */
  async registerViaShareLink(code: string, dto: JoinRegisterDto): Promise<JoinResult> {
    let verificationToken = '';
    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      // Locked and type-checked inside the transaction: a coach invite must not
      // be spendable here, and the single-use count must not be racy.
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.PlayerStatic,
        manager,
      );

      const existing = await this.usersService.findByEmail(dto.email);
      if (existing) {
        throw new ConflictException({
          errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
          message: 'An account with this email already exists. Log in to join this trainer.',
        });
      }

      const { user, verificationToken: token } = await this.authService.createUnverifiedPlayer(
        {
          email: dto.email,
          password: dto.password,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        },
        manager,
      );
      verificationToken = token;

      const profile = await this.playersService.create(
        {
          ownerUserId: user.id,
          displayName: displayNameFor(dto, dto.email),
          isChild: false,
          gender: dto.gender ?? null,
          birthDate: dto.birthDate ?? null,
        },
        manager,
      );

      const { association } = await this.associations.associate(
        {
          trainerProfileId: link.trainerProfileId,
          playerProfileId: profile.id,
          shareLinkId: link.id,
        },
        manager,
      );

      await this.shareLinks.incrementUse(link.id, manager);

      return { user, profile, association, trainerProfileId: link.trainerProfileId };
    });

    const trainerName = await this.trainerName(result.trainerProfileId);
    await this.mail.sendVerificationEmail(result.user.email, verificationToken);
    await this.mail.sendJoinConfirmationEmail(result.user.email, trainerName);

    return {
      message: 'Registration received. Verify your email to finish joining.',
      associationId: result.association.id,
      trainerProfileId: result.trainerProfileId,
      playerProfileId: result.profile.id,
    };
  }

  /**
   * Existing logged-in player joins another trainer via a ShareLink — no
   * duplicate account, just a new association (multi-trainer support).
   */
  async joinAsExistingPlayer(code: string, principal: Principal): Promise<JoinResult> {
    if (principal.isChild) {
      await this.notifyParentOfChildJoinAttempt(principal, code);
      throw new ForbiddenException({
        errorCode: ErrorCode.CHILD_CANNOT_ADD_TRAINER,
        message: 'Ask your parent to register you with this trainer.',
      });
    }

    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.PlayerStatic,
        manager,
      );

      let profile: PlayerProfile | null = await this.playersService.findSelfProfile(
        principal.userId,
        manager,
      );
      if (!profile) {
        const user = (await this.usersService.findById(principal.userId)) as User;
        profile = await this.playersService.create(
          {
            ownerUserId: principal.userId,
            displayName: displayNameFor(user, user.email),
            isChild: false,
          },
          manager,
        );
      }

      const { association, created } = await this.associations.associate(
        {
          trainerProfileId: link.trainerProfileId,
          playerProfileId: profile.id,
          shareLinkId: link.id,
        },
        manager,
      );
      if (created) {
        await this.shareLinks.incrementUse(link.id, manager);
      }

      return { profile, association, created, trainerProfileId: link.trainerProfileId };
    });

    return {
      message: result.created
        ? 'You are now connected with this trainer.'
        : 'You are already connected with this trainer.',
      associationId: result.association.id,
      trainerProfileId: result.trainerProfileId,
      playerProfileId: result.profile.id,
    };
  }

  /**
   * US-01.06: a child clicking a trainer's ShareLink is blocked, and the parent
   * is emailed the link so they can complete the registration.
   *
   * Deliberately best-effort. The block is the security control and must hold
   * whether or not the mail provider is reachable; swallowing the failure here
   * keeps a provider outage from turning a 403 into a 500 that looks, to the
   * child, like the link might work on a retry.
   */
  private async notifyParentOfChildJoinAttempt(principal: Principal, code: string): Promise<void> {
    try {
      if (principal.parentUserId === null) {
        return;
      }
      const parent = await this.usersService.findById(principal.parentUserId);
      const link = await this.shareLinks.findByCode(code);
      if (!parent || !link || link.type !== ShareLinkType.PlayerStatic) {
        return;
      }
      const child = principal.childPlayerProfileId
        ? await this.playersService.findById(principal.childPlayerProfileId)
        : null;

      await this.mail.sendChildJoinRequestEmail(parent.email, {
        childName: child?.displayName ?? 'Your child',
        trainerName: await this.trainerName(link.trainerProfileId),
        code: link.code,
      });
    } catch (error) {
      this.logger.error(
        `Blocked child ${principal.userId} from joining via ${code}; parent notification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async trainerName(trainerProfileId: string): Promise<string> {
    const profile = await this.trainersService.findById(trainerProfileId);
    return profile?.businessName ?? 'your trainer';
  }
}
