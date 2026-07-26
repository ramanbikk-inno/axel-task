import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { AuditService } from '../audit/audit.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { PasswordService } from '../../shared/crypto/password.service';
import { ageInYears, parseCalendarDate } from '../../shared/validation/calendar-date';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { ContextService } from '../auth/context.service';
import { AssociationsService } from '../enrollment/associations.service';
import { ShareLinkType } from '../enrollment/entities/share-link.entity';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { Role, UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { ChildLoginStatusView, ChildLoginView } from './dto/child-login.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { UpdateChildDto } from './dto/update-child.dto';
import { FamilyContextView } from './dto/family-context.view';
import { PlayerProfileView, TrainerContextView } from './dto/player-profile.view';

export const AUDIT_CHILD_CREATED = 'family.child-created';
export const AUDIT_CHILD_UPDATED = 'family.child-updated';
export const AUDIT_CHILD_LOGIN_CREATED = 'family.child-login-created';
export const AUDIT_CHILD_LOGIN_REVOKED = 'family.child-login-revoked';
export const AUDIT_FAMILY_TRAINER_ADDED = 'family.trainer-added';
export const AUDIT_FAMILY_TRAINER_REMOVED = 'family.trainer-removed';

@Injectable()
export class FamilyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly associations: AssociationsService,
    private readonly shareLinks: ShareLinksService,
    private readonly trainersService: TrainersService,
    private readonly context: ContextService,
    private readonly usersService: UsersService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
  ) {}

  /**
   * All profiles owned by the parent (self + children), each with its trainers.
   *
   * For a child login this is their single profile and nothing else. Keying on
   * `ownerUserId` alone would return an empty list for a child — their profile
   * belongs to the parent — which reads as "no data" rather than "your data".
   */
  async listFamily(principal: Principal): Promise<PlayerProfileView[]> {
    if (principal.isChild) {
      const own =
        principal.childPlayerProfileId === null
          ? null
          : await this.playersService.findById(principal.childPlayerProfileId);
      return own ? this.buildViews([own]) : [];
    }
    const profiles = await this.playersService.findByOwner(principal.userId);
    return this.buildViews(profiles);
  }

  /** Create a child profile and optionally connect it to the parent's trainers. */
  async createChild(actor: Principal, dto: CreateChildDto): Promise<PlayerProfileView> {
    const parentUserId = actor.userId;
    const birthDate = this.requireChildAge(dto.birthDate);

    const owned = await this.playersService.findByOwner(parentUserId);
    const duplicate = owned.some(
      (p) =>
        p.isChild &&
        p.displayName.trim().toLowerCase() === dto.displayName.trim().toLowerCase() &&
        p.birthDate === birthDate,
    );
    if (duplicate) {
      throw new ConflictException({
        errorCode: ErrorCode.DUPLICATE_CHILD,
        message: 'A child with the same name and birth date already exists.',
      });
    }

    const requested = dto.trainerProfileIds ?? [];
    if (requested.length > 0) {
      const parentTrainers = await this.parentTrainerProfileIds(owned);
      for (const trainerProfileId of requested) {
        if (!parentTrainers.has(trainerProfileId)) {
          throw new ForbiddenException({
            errorCode: ErrorCode.TRAINER_NOT_ASSOCIATED,
            message: 'You can only add a child to trainers you are associated with.',
          });
        }
      }
    }

    const child = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.playersService.create(
        {
          ownerUserId: parentUserId,
          displayName: dto.displayName,
          isChild: true,
          birthDate,
          gender: dto.gender,
          school: dto.school ?? null,
          jerseyNumber: dto.jerseyNumber ?? null,
        },
        manager,
      );

      for (const trainerProfileId of requested) {
        await this.associations.associate(
          { trainerProfileId, playerProfileId: created.id },
          manager,
        );
      }

      return created;
    });

    await this.audit.record({
      action: AUDIT_CHILD_CREATED,
      actor,
      target: { type: 'PlayerProfile', id: child.id },
      metadata: { trainerProfileIds: requested },
    });

    const [view] = await this.buildViews([child]);
    return view;
  }

  /**
   * Amend a child profile — every creation field, plus `emergency_contact`,
   * which no request DTO previously carried.
   *
   * Parent-only: a child may edit basic profile info, but not through a route
   * that can also move their birth date.
   */
  async updateChild(
    actor: Principal,
    profileId: string,
    dto: UpdateChildDto,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    if (!profile.isChild) {
      // The account holder's own profile is edited through PATCH /profile/me,
      // which knows about the user row behind it. Routing it here would let a
      // parent put themselves outside the 1-18 bound below.
      throw new BadRequestException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'Use /profile/me to edit your own profile.',
      });
    }

    // Validated only when supplied, so an untouched profile is never re-checked
    // against a bound it may have aged out of since it was created.
    const newBirthDate: string | undefined =
      dto.birthDate === undefined ? undefined : this.requireChildAge(dto.birthDate);
    const birthDate = newBirthDate ?? profile.birthDate;
    const displayName = dto.displayName ?? profile.displayName;

    // Re-run the create-time duplicate rule whenever either half of the identity
    // moves, or renaming would be a way round it.
    if (dto.displayName !== undefined || dto.birthDate !== undefined) {
      const owned = await this.playersService.findByOwner(actor.userId);
      const duplicate = owned.some(
        (p) =>
          p.id !== profile.id &&
          p.isChild &&
          p.displayName.trim().toLowerCase() === displayName.trim().toLowerCase() &&
          p.birthDate === birthDate,
      );
      if (duplicate) {
        throw new ConflictException({
          errorCode: ErrorCode.DUPLICATE_CHILD,
          message: 'A child with the same name and birth date already exists.',
        });
      }
    }

    const updated = await this.playersService.updateChildProfile(profile.id, {
      displayName: dto.displayName,
      birthDate: newBirthDate,
      gender: dto.gender,
      school: dto.school,
      jerseyNumber: dto.jerseyNumber,
      emergencyContact: dto.emergencyContact,
    });

    await this.audit.record({
      action: AUDIT_CHILD_UPDATED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      // Which fields moved, never their values: this row outlives the data and
      // must not become a second copy of the PII the erasure path clears.
      metadata: {
        fields: Object.keys(dto).filter((k) => dto[k as keyof UpdateChildDto] !== undefined),
      },
    });

    const [view] = await this.buildViews([updated]);
    return view;
  }

  /**
   * Context-switcher data: the parent's own context + each child's contexts.
   *
   * A child sees a flat list of their own trainers, with no "Me" section.
   */
  async getContext(principal: Principal): Promise<FamilyContextView> {
    const views = await this.listFamily(principal);
    if (principal.isChild) {
      return { self: null, children: views };
    }
    return {
      self: views.find((v) => !v.isChild) ?? null,
      children: views.filter((v) => v.isChild),
    };
  }

  /** Connect an owned profile to a trainer the parent is already associated with. */
  async addTrainerFromExisting(
    actor: Principal,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
    const parentUserId = actor.userId;
    const profile = await this.requireOwnedProfile(parentUserId, profileId);

    const owned = await this.playersService.findByOwner(parentUserId);
    const parentTrainers = await this.parentTrainerProfileIds(owned);
    if (!parentTrainers.has(trainerProfileId)) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_NOT_ASSOCIATED,
        message: 'You can only add a profile to trainers you are associated with.',
      });
    }

    await this.associations.associate({ trainerProfileId, playerProfileId: profile.id });
    await this.audit.record({
      action: AUDIT_FAMILY_TRAINER_ADDED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { trainerProfileId, via: 'my-trainers' },
    });
    const [view] = await this.buildViews([profile]);
    return view;
  }

  /** Connect an owned profile to a (possibly new) trainer via a ShareLink code. */
  async addTrainerByCode(
    actor: Principal,
    profileId: string,
    code: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    let joinedTrainerProfileId: string | null = null;

    await this.dataSource.transaction(async (manager: EntityManager) => {
      // Player links only: a parent pasting a coach invite code here used to
      // consume the trainer's single-use coach invitation.
      const link = await this.shareLinks.lockForRedemption(
        code,
        ShareLinkType.PlayerStatic,
        manager,
      );

      const { created } = await this.associations.associate(
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
      joinedTrainerProfileId = link.trainerProfileId;
    });

    await this.audit.record({
      action: AUDIT_FAMILY_TRAINER_ADDED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { trainerProfileId: joinedTrainerProfileId, via: 'share-link' },
    });

    const [view] = await this.buildViews([profile]);
    return view;
  }

  /**
   * Disconnect an owned profile from a trainer. The association is deactivated
   * (soft-deleted) so history is preserved.
   */
  async removeTrainer(
    actor: Principal,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);

    const updated = await this.associations.setStatus(
      trainerProfileId,
      profile.id,
      AssociationStatus.Inactive,
    );
    if (!updated) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This profile is not connected to that trainer.',
      });
    }

    // Any session sitting in this context is now pointed at a trainer the
    // profile is no longer connected to. Drop it rather than leave the
    // selection dangling until the user happens to switch again.
    await this.context.clearForAssociation(profile.id, trainerProfileId);

    await this.audit.record({
      action: AUDIT_FAMILY_TRAINER_REMOVED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { trainerProfileId },
    });

    const [view] = await this.buildViews([profile]);
    return view;
  }

  /**
   * Give a child profile its own login. The account is an ordinary PlayerParent;
   * what makes it a child is `player_profiles.child_user_id` pointing at it. The
   * link is unique and a CHECK refuses it on a profile that is not a child.
   */
  async createChildLogin(
    actor: Principal,
    profileId: string,
    input: { email: string; password: string },
  ): Promise<ChildLoginView> {
    const parentUserId = actor.userId;
    const profile = await this.requireOwnedProfile(parentUserId, profileId);
    if (!profile.isChild) {
      throw new BadRequestException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'Only a child profile can be given its own login.',
      });
    }
    if (profile.childUserId !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.CHILD_LOGIN_EXISTS,
        message: 'This child already has a login.',
      });
    }

    const existing = await this.usersService.findByEmail(input.email);
    if (existing) {
      // Not enumeration-sensitive: the caller is an authenticated parent
      // choosing an address, and a silent no-op here would leave them thinking
      // the login was created.
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      });
    }

    const passwordHash = await this.passwords.hash(input.password);
    const childUser = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.usersService.create(
        {
          email: input.email,
          role: Role.PlayerParent,
          passwordHash,
          firstName: profile.displayName,
          // The parent vouching for the address is the verification; there is
          // no separate mailbox to confirm.
          emailVerified: true,
          mustSetPassword: false,
          status: UserStatus.Active,
        },
        manager,
      );
      await manager
        .getRepository(PlayerProfile)
        .update({ id: profile.id }, { childUserId: created.id });
      return created;
    });

    await this.audit.record({
      action: AUDIT_CHILD_LOGIN_CREATED,
      actor,
      targetUserId: childUser.id,
      target: { type: 'PlayerProfile', id: profile.id },
    });

    return {
      playerProfileId: profile.id,
      displayName: profile.displayName,
      childUserId: childUser.id,
      email: childUser.email,
    };
  }

  /**
   * Revoke a child's login. The profile stays; only the ability to sign in as
   * it goes away, along with every session currently doing so — otherwise a
   * live child session keeps working for up to its refresh lifetime after the
   * parent has withdrawn access.
   */
  async revokeChildLogin(actor: Principal, profileId: string): Promise<void> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    if (profile.childUserId === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This child does not have a login.',
      });
    }

    const childUserId = profile.childUserId;
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.getRepository(PlayerProfile).update({ id: profile.id }, { childUserId: null });
      await this.usersService.setStatus(childUserId, UserStatus.Inactive, manager);
    });
    await this.auth.revokeAllUserSessions(childUserId, 'child-login-revoked');
    await this.audit.record({
      action: AUDIT_CHILD_LOGIN_REVOKED,
      actor,
      targetUserId: childUserId,
      target: { type: 'PlayerProfile', id: profile.id },
    });
  }

  async childLoginStatus(parentUserId: string, profileId: string): Promise<ChildLoginStatusView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);
    if (profile.childUserId === null) {
      return { hasLogin: false };
    }
    const user = await this.usersService.findById(profile.childUserId);
    return user ? { hasLogin: true, childUserId: user.id, email: user.email } : { hasLogin: false };
  }

  private async requireOwnedProfile(
    parentUserId: string,
    profileId: string,
  ): Promise<PlayerProfile> {
    const profile = await this.playersService.findById(profileId);
    // One answer for "no such profile" and "not yours". The split used to
    // return 404 for the first and 403 for the second, which told a caller
    // holding an id whether it named a real profile belonging to someone else
    // — and it disagreed with the context-switch endpoint, which already
    // collapsed both into 404.
    if (!profile || profile.ownerUserId !== parentUserId) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Player profile not found.',
      });
    }
    return profile;
  }

  /** Distinct active trainer profile ids across all of the parent's profiles. */
  private async parentTrainerProfileIds(ownedProfiles: PlayerProfile[]): Promise<Set<string>> {
    const associations = await this.associations.findByPlayerProfiles(
      ownedProfiles.map((p) => p.id),
    );
    return new Set(
      associations
        .filter((a) => a.status === AssociationStatus.Active)
        .map((a) => a.trainerProfileId),
    );
  }

  private async buildViews(profiles: PlayerProfile[]): Promise<PlayerProfileView[]> {
    if (profiles.length === 0) {
      return [];
    }
    const associations = (
      await this.associations.findByPlayerProfiles(profiles.map((p) => p.id))
    ).filter((a) => a.status === AssociationStatus.Active);
    const trainerIds = [...new Set(associations.map((a) => a.trainerProfileId))];
    const trainers = await this.trainersService.findByIds(trainerIds);
    const nameById = new Map(trainers.map((t) => [t.id, t.businessName]));

    const byProfile = new Map<string, TrainerContextView[]>();
    for (const a of associations) {
      const list = byProfile.get(a.playerProfileId) ?? [];
      list.push({
        trainerProfileId: a.trainerProfileId,
        businessName: nameById.get(a.trainerProfileId) ?? 'Unknown',
        status: a.status,
        connectedAt: a.connectedAt,
      });
      byProfile.set(a.playerProfileId, list);
    }

    return profiles.map((p) => PlayerProfileView.from(p, byProfile.get(p.id) ?? []));
  }

  /**
   * Enforce the 1-18 rule and return the normalised YYYY-MM-DD date. Fails closed
   * on an unparseable value: NaN compares false against both bounds, so a bad
   * date used to sail through. Second line of defence behind the DTO.
   */
  private requireChildAge(rawBirthDate: string): string {
    const born = parseCalendarDate(rawBirthDate);
    if (born === null) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate must be a calendar date in YYYY-MM-DD format.',
      });
    }

    const age = ageInYears(born, this.clock.now());
    if (age < 1 || age > 18) {
      throw new BadRequestException({
        errorCode: ErrorCode.CHILD_AGE_INVALID,
        message: 'A child must be between 1 and 18 years old.',
      });
    }
    return born.toISOString().slice(0, 10);
  }
}
