import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { displayNameFor } from '../../shared/format/display-name';
import { AgeGateService } from '../../shared/registration/age-gate.service';
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
import { JoinRegisterDto } from './dto/join-register.dto';
import { ShareLinkType } from './entities/share-link.entity';
import { AssociationStatus } from './entities/trainer-player-association.entity';
import { ShareLinksService } from './share-links.service';

export interface JoinResult {
  message: string;
  associationId: string;
  trainerProfileId: string;
  /** The first profile connected; kept for callers written before multi-select. */
  playerProfileId: string;
  playerProfileIds: string[];
}

export const AUDIT_ENROLLMENT_JOINED = 'enrollment.joined';
export const AUDIT_ENROLLMENT_REGISTERED = 'enrollment.registered';

/**
 * The public join workflow: registering through a trainer's ShareLink, and an
 * existing player connecting to another trainer. Link administration lives on
 * ShareLinksService, the trainer-side roster on RosterService.
 */
@Injectable()
export class JoinService {
  private readonly logger = new Logger(JoinService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly ageGate: AgeGateService,
    private readonly usersService: UsersService,
    private readonly playersService: PlayersService,
    private readonly trainersService: TrainersService,
    private readonly shareLinks: ShareLinksService,
    private readonly associations: AssociationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * New player/parent registers via a trainer's ShareLink: creates the account
   * + self player profile + trainer association, then emails verification and a
   * join confirmation.
   */
  async registerViaShareLink(code: string, dto: JoinRegisterDto): Promise<JoinResult> {
    // Registration's age floor applies here too — a second public way to mint an
    // account. Before the transaction, so a refusal costs no link use.
    this.ageGate.assertOldEnoughForOwnAccount(dto.birthDate);

    // Also before it: argon2id is ~40ms of CPU, and the transaction holds a row
    // lock on the ShareLink for as long as it runs.
    const passwordHash = await this.passwords.hash(dto.password);

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
          passwordHash,
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
   * The "Who will train with [New Trainer]?" prompt: the caller's own profiles
   * and each child's, with the already-connected ones flagged so the client can
   * pre-tick and disable them.
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
   * With `playerProfileIds`, only those family members are connected. Without it
   * the caller's own profile joins, which is what a player with no children
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
   * A child clicking a trainer's ShareLink is blocked and the parent is emailed
   * the link instead. Best-effort: the block is the control, so a mail outage
   * must not turn the 403 into a 500 that looks worth retrying.
   */
  private async notifyParentOfChildJoinAttempt(principal: Principal, code: string): Promise<void> {
    try {
      if (principal.parentUserId === null) {
        return;
      }
      const parent = await this.usersService.findById(principal.parentUserId);
      const link = await this.shareLinks.findByCode(code);
      if (!parent || !link) {
        return;
      }
      // Kind confusion still blocks, but an expired or spent link does not: the
      // parent is told about a stale code too, so they can ask for a fresh one.
      const evaluation = this.shareLinks.evaluate(link, ShareLinkType.PlayerStatic);
      if (!evaluation.ok && evaluation.reason === 'wrong-type') {
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
