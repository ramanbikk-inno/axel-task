import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { PasswordService } from '../../shared/crypto/password.service';
import { parseCalendarDate } from '../../shared/validation/calendar-date';
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
import { FamilyContextView } from './dto/family-context.view';
import { PlayerProfileView, TrainerContextView } from './dto/player-profile.view';

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
  async createChild(parentUserId: string, dto: CreateChildDto): Promise<PlayerProfileView> {
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

    const [view] = await this.buildViews([child]);
    return view;
  }

  /**
   * Context-switcher data: the parent's own context + each child's contexts.
   *
   * A child sees a flat list of their own trainers with no "Me" section, which
   * is exactly the shape US-01.06 documents for the child selector.
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
    parentUserId: string,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
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
    const [view] = await this.buildViews([profile]);
    return view;
  }

  /** Connect an owned profile to a (possibly new) trainer via a ShareLink code. */
  async addTrainerByCode(
    parentUserId: string,
    profileId: string,
    code: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);

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
    });

    const [view] = await this.buildViews([profile]);
    return view;
  }

  /**
   * Disconnect an owned profile from a trainer. The association is deactivated
   * (soft-deleted) so history is preserved.
   */
  async removeTrainer(
    parentUserId: string,
    profileId: string,
    trainerProfileId: string,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);

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

    const [view] = await this.buildViews([profile]);
    return view;
  }

  /**
   * Give a child profile its own login (US-01.06).
   *
   * The account is a PlayerParent like any other player; what makes it a child
   * account is `player_profiles.child_user_id` pointing at it, which the
   * session validator reads on every request. The database enforces both rules
   * that matter: the link is unique, and a CHECK refuses it on a profile that
   * is not a child.
   */
  async createChildLogin(
    parentUserId: string,
    profileId: string,
    input: { email: string; password: string },
  ): Promise<ChildLoginView> {
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
  async revokeChildLogin(parentUserId: string, profileId: string): Promise<void> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);
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
      });
      byProfile.set(a.playerProfileId, list);
    }

    return profiles.map((p) => PlayerProfileView.from(p, byProfile.get(p.id) ?? []));
  }

  /**
   * Enforce the 1-18 rule and return the normalised YYYY-MM-DD date.
   *
   * Fails closed on an unparseable value. The previous version returned NaN for
   * anything Date could not read, and `NaN < 1` and `NaN > 18` are both false,
   * so the range check waved it through — an adult could be stored as a child.
   * The DTO now rejects those inputs too; this is the second line of defence,
   * because the service is also reachable from paths that do not share the DTO.
   */
  private requireChildAge(rawBirthDate: string): string {
    const born = parseCalendarDate(rawBirthDate);
    if (born === null) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate must be a calendar date in YYYY-MM-DD format.',
      });
    }

    const now = this.clock.now();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - born.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) {
      age -= 1;
    }

    if (age < 1 || age > 18) {
      throw new BadRequestException({
        errorCode: ErrorCode.CHILD_AGE_INVALID,
        message: 'A child must be between 1 and 18 years old.',
      });
    }
    return born.toISOString().slice(0, 10);
  }
}
