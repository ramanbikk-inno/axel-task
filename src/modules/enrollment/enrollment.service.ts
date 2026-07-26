import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { MailService } from '../mail/mail.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AssociationsService } from './associations.service';
import { JoinMembersPromptView } from './dto/join-members.dto';
import { RosterEntryView } from './dto/roster.dto';
import { JoinRegisterDto } from './dto/join-register.dto';
import { ShareLink, ShareLinkType } from './entities/share-link.entity';
import { AssociationStatus } from './entities/trainer-player-association.entity';
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
  /** The first profile connected; kept for callers written before multi-select. */
  playerProfileId: string;
  playerProfileIds: string[];
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

export const AUDIT_SHARE_LINK_CREATED = 'sharelink.created';
export const AUDIT_ENROLLMENT_JOINED = 'enrollment.joined';
export const AUDIT_ENROLLMENT_REGISTERED = 'enrollment.registered';

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
    private readonly audit: AuditService,
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
    const link = await this.shareLinks.create({
      trainerProfileId: trainerProfile.id,
      type: ShareLinkType.PlayerStatic,
      createdByUserId: principal.userId,
    });
    await this.audit.record({
      action: AUDIT_SHARE_LINK_CREATED,
      actor: principal,
      target: { type: 'ShareLink', id: link.id },
      metadata: { linkType: ShareLinkType.PlayerStatic },
    });
    return link;
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

    // recordSystemAction, not record: this endpoint is public, so there is no
    // authenticated principal to attribute it to — and the account being
    // created is the subject of the action, not its actor.
    await this.audit.recordSystemAction({
      action: AUDIT_ENROLLMENT_REGISTERED,
      targetUserId: result.user.id,
      target: { type: 'TrainerOrg', id: result.trainerProfileId },
      metadata: { playerProfileId: result.profile.id },
    });

    const trainerName = await this.trainerName(result.trainerProfileId);
    await this.mail.sendVerificationEmail(result.user.email, verificationToken);
    await this.mail.sendJoinConfirmationEmail(result.user.email, trainerName);

    return {
      message: 'Registration received. Verify your email to finish joining.',
      associationId: result.association.id,
      trainerProfileId: result.trainerProfileId,
      playerProfileId: result.profile.id,
      playerProfileIds: [result.profile.id],
    };
  }

  /**
   * Existing logged-in player joins another trainer via a ShareLink — no
   * duplicate account, just a new association (multi-trainer support).
   */
  /**
   * The "Who will train with [New Trainer]?" prompt from US-01.02.
   *
   * Lists the caller's own profiles — themselves and each child — with the
   * ones already connected flagged, so the client can pre-tick and disable
   * them rather than offering a choice that would be a no-op.
   */
  async eligibleMembers(code: string, principal: Principal): Promise<JoinMembersPromptView> {
    const link = await this.shareLinks.requireUsable(code, ShareLinkType.PlayerStatic);
    const trainer = await this.trainersService.findById(link.trainerProfileId);

    const owned = await this.playersService.findByOwner(principal.userId);
    const existing = await this.associations.findByPlayerProfiles(owned.map((p) => p.id));
    const connected = new Set(
      existing
        .filter(
          (a) =>
            a.trainerProfileId === link.trainerProfileId && a.status === AssociationStatus.Active,
        )
        .map((a) => a.playerProfileId),
    );

    return {
      trainerProfileId: link.trainerProfileId,
      trainerName: trainer?.businessName ?? 'this trainer',
      // Self first, then children: the same order the selector renders.
      members: [...owned]
        .sort((a, b) => Number(a.isChild) - Number(b.isChild))
        .map((p) => ({
          playerProfileId: p.id,
          displayName: p.displayName,
          isChild: p.isChild,
          alreadyAssociated: connected.has(p.id),
        })),
    };
  }

  /**
   * Existing logged-in player joins another trainer via a ShareLink — no
   * duplicate account, just new associations (multi-trainer support).
   *
   * With `playerProfileIds`, only those family members are connected, which is
   * what US-01.02 asks for. Without it, the caller's own profile joins, which
   * is what this endpoint did before and what a player with no children still
   * means by "join".
   */
  async joinAsExistingPlayer(
    code: string,
    principal: Principal,
    playerProfileIds?: string[],
  ): Promise<JoinResult> {
    if (principal.isChild) {
      await this.notifyParentOfChildJoinAttempt(principal, code);
      throw new ForbiddenException({
        errorCode: ErrorCode.CHILD_CANNOT_ADD_TRAINER,
        message: 'Ask your parent to register you with this trainer.',
      });
    }

    // Resolved against what the caller actually owns, before the transaction
    // and before the link is spent: a selection naming somebody else's child
    // must not be able to consume a use of the link on its way to being
    // refused.
    const selected = await this.resolveSelectedProfiles(principal, playerProfileIds);

    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.PlayerStatic,
        manager,
      );

      const profiles =
        selected.length > 0 ? selected : [await this.requireSelfProfile(principal.userId, manager)];

      let createdAny = false;
      const associations = [];
      for (const profile of profiles) {
        const { association, created } = await this.associations.associate(
          {
            trainerProfileId: link.trainerProfileId,
            playerProfileId: profile.id,
            shareLinkId: link.id,
          },
          manager,
        );
        associations.push(association);
        createdAny = createdAny || created;
      }

      // One use per redemption, however many family members it connected —
      // counting per profile would let a family of four exhaust a link with
      // maxUses four times faster than a single player.
      if (createdAny) {
        await this.shareLinks.incrementUse(link.id, manager);
      }

      return {
        profiles,
        associations,
        created: createdAny,
        trainerProfileId: link.trainerProfileId,
      };
    });

    await this.audit.record({
      action: AUDIT_ENROLLMENT_JOINED,
      actor: principal,
      target: { type: 'TrainerOrg', id: result.trainerProfileId },
      metadata: {
        playerProfileIds: result.profiles.map((p) => p.id),
        created: result.created,
      },
    });

    return {
      message: result.created
        ? 'You are now connected with this trainer.'
        : 'You are already connected with this trainer.',
      associationId: result.associations[0].id,
      trainerProfileId: result.trainerProfileId,
      playerProfileId: result.profiles[0].id,
      playerProfileIds: result.profiles.map((p) => p.id),
    };
  }

  /**
   * The caller's own profiles matching the requested ids.
   *
   * Keyed on `principal.userId`, so an id belonging to another family simply
   * is not in the set — and a partial match is refused outright rather than
   * silently joining the subset that happened to be theirs.
   */
  private async resolveSelectedProfiles(
    principal: Principal,
    requested?: string[],
  ): Promise<PlayerProfile[]> {
    if (requested === undefined || requested.length === 0) {
      return [];
    }
    const owned = await this.playersService.findByOwner(principal.userId);
    const byId = new Map(owned.map((p) => [p.id, p]));
    const resolved = requested.map((id) => byId.get(id));

    if (resolved.some((p) => p === undefined)) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'One or more of the selected profiles was not found.',
      });
    }
    return resolved as PlayerProfile[];
  }

  /** The account holder's own trainee profile, created on demand. */
  private async requireSelfProfile(userId: string, manager: EntityManager): Promise<PlayerProfile> {
    const existing = await this.playersService.findSelfProfile(userId, manager);
    if (existing) {
      return existing;
    }
    const user = (await this.usersService.findById(userId)) as User;
    return this.playersService.create(
      {
        ownerUserId: userId,
        displayName: displayNameFor(user, user.email),
        isChild: false,
      },
      manager,
    );
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

  /**
   * The trainer's roster (US-01.02: "Player profile created in trainer's CRM").
   *
   * Scoped to the caller's own organisation, resolved from their user id — a
   * trainer cannot pass an org id and read someone else's roster, because
   * there is nowhere to pass one.
   */
  async roster(
    principal: Principal,
    query: { search?: string; includeInactive?: boolean } = {},
  ): Promise<RosterEntryView[]> {
    const trainer = await this.trainersService.findByUserId(principal.userId);
    if (!trainer) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }

    const associations = (await this.associations.findByTrainer(trainer.id)).filter(
      (a) => query.includeInactive === true || a.status === AssociationStatus.Active,
    );
    if (associations.length === 0) {
      return [];
    }

    const profiles = await this.playersService.findByIds(
      associations.map((a) => a.playerProfileId),
    );
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const accounts = await this.usersService.findByIds([
      ...new Set(profiles.map((p) => p.ownerUserId)),
    ]);
    const accountById = new Map(accounts.map((u) => [u.id, u]));

    const rows = associations
      .map((a) => {
        const profile = profileById.get(a.playerProfileId);
        if (!profile) {
          return null;
        }
        const account = accountById.get(profile.ownerUserId);
        return {
          playerProfileId: profile.id,
          displayName: profile.displayName,
          isChild: profile.isChild,
          birthDate: profile.birthDate,
          gender: profile.gender,
          skillLevel: profile.skillLevel,
          school: profile.school,
          jerseyNumber: profile.jerseyNumber,
          accountUserId: profile.ownerUserId,
          accountEmail: account?.email ?? null,
          accountName: account ? displayNameFor(account, account.email) : null,
          accountPhone: account?.phone ?? null,
          status: a.status,
          connectedAt: a.connectedAt,
        };
      })
      .filter((r): r is RosterEntryView => r !== null);

    const search = query.search?.trim().toLowerCase();
    if (!search) {
      return rows;
    }
    return rows.filter((r) =>
      [r.displayName, r.accountEmail, r.accountName].some(
        (field) => field !== null && field.toLowerCase().includes(search),
      ),
    );
  }

  private async trainerName(trainerProfileId: string): Promise<string> {
    const profile = await this.trainersService.findById(trainerProfileId);
    return profile?.businessName ?? 'your trainer';
  }
}
