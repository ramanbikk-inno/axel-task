import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { ErrorCode } from '../../shared/errors/error-codes';
import { decodeImageUpload, MAX_IMAGE_UPLOAD_BYTES } from '../../shared/files/image-content';
import { ageInYears, parseCalendarDate } from '../../shared/validation/calendar-date';
import { Principal } from '../auth/principal';
import { ContextService } from '../auth/context.service';
import { AssociationsService } from '../enrollment/associations.service';
import { ShareLinkType } from '../enrollment/entities/share-link.entity';
import { AssociationStatus } from '../enrollment/entities/trainer-player-association.entity';
import { ShareLinksService } from '../enrollment/share-links.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { UploadPhotoDto } from '../profile/dto/profile.dto';
import { replaceStoredAsset } from '../storage/replace-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainersService } from '../trainers/trainers.service';
import { ChildAccountService } from './child-account.service';
import { findSimilarChildren } from './child-similarity';
import { ChildLoginStatusView, ChildLoginView } from './dto/child-login.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { UpdateChildDto } from './dto/update-child.dto';
import { FamilyContextView } from './dto/family-context.view';
import { PlayerProfileView, TrainerContextView } from './dto/player-profile.view';
import { SimilarChildrenQueryDto, SimilarChildrenView } from './dto/similar-children.dto';

export const AUDIT_CHILD_CREATED = 'family.child-created';
export const AUDIT_CHILD_UPDATED = 'family.child-updated';
export const AUDIT_CHILD_PHOTO_UPDATED = 'family.child-photo-updated';
export const AUDIT_CHILD_PHOTO_REMOVED = 'family.child-photo-removed';
export const AUDIT_FAMILY_TRAINER_ADDED = 'family.trainer-added';
export const AUDIT_FAMILY_TRAINER_REMOVED = 'family.trainer-removed';

/** Moved with the credential lifecycle; re-exported for existing importers. */
export { AUDIT_CHILD_LOGIN_CREATED, AUDIT_CHILD_LOGIN_REVOKED } from './child-account.service';

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly playersService: PlayersService,
    private readonly associations: AssociationsService,
    private readonly shareLinks: ShareLinksService,
    private readonly trainersService: TrainersService,
    private readonly context: ContextService,
    private readonly childAccounts: ChildAccountService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageService,
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

  /**
   * Children already on the account that resemble the one the parent is about
   * to add — the advisory half of US-01.03's duplicate check. Read-only, so a
   * near miss warns rather than blocks; only an exact match is refused, and
   * even that yields to `allowDuplicate`.
   */
  async findSimilarChildren(
    parentUserId: string,
    query: SimilarChildrenQueryDto,
  ): Promise<SimilarChildrenView> {
    const owned = await this.playersService.findByOwner(parentUserId);
    const matches = findSimilarChildren(
      owned.filter((p) => p.isChild),
      { displayName: query.displayName, birthDate: query.birthDate ?? null },
      query.excludeProfileId,
    );
    return { matches, hasExactMatch: matches.some((m) => m.exact) };
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
    if (duplicate && dto.allowDuplicate !== true) {
      throw new ConflictException({
        errorCode: ErrorCode.DUPLICATE_CHILD,
        message:
          'A child with the same name and birth date already exists. ' +
          'Send allowDuplicate to add them anyway.',
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
      if (duplicate && dto.allowDuplicate !== true) {
        throw new ConflictException({
          errorCode: ErrorCode.DUPLICATE_CHILD,
          message:
            'A child with the same name and birth date already exists. ' +
            'Send allowDuplicate to proceed anyway.',
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
      allowChildTokenSpendNoApproval: dto.allowChildTokenSpendNoApproval,
    });

    await this.audit.record({
      action: AUDIT_CHILD_UPDATED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { fields: changedFields(dto) },
    });

    const [view] = await this.buildViews([updated]);
    return view;
  }

  /** Only a child profile has its own photo; the account holder's own is on `users`. */
  async uploadChildPhoto(
    actor: Principal,
    profileId: string,
    dto: UploadPhotoDto,
  ): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    if (!profile.isChild) {
      throw new BadRequestException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'Use /profile/me/photo for your own photo.',
      });
    }

    const { buffer } = decodeImageUpload({
      dataBase64: dto.dataBase64,
      declaredMimeType: dto.mimeType,
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
      label: 'Child photo',
    });
    const { persisted: updated } = await replaceStoredAsset({
      storage: this.storage,
      logger: this.logger,
      previousPublicId: profile.photoPublicId,
      upload: { buffer, fileName: dto.fileName, mimeType: dto.mimeType, folder: 'avatars' },
      persist: (stored) => this.playersService.setPhoto(profile.id, stored),
    });

    await this.audit.record({
      action: AUDIT_CHILD_PHOTO_UPDATED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { fileName: dto.fileName },
    });

    const [view] = await this.buildViews([updated]);
    return view;
  }

  async removeChildPhoto(actor: Principal, profileId: string): Promise<PlayerProfileView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    if (!profile.isChild) {
      throw new BadRequestException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'Use /profile/me/photo for your own photo.',
      });
    }
    if (profile.photoPublicId === null && profile.photoUrl === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'There is no photo to remove.',
      });
    }

    const { persisted: updated } = await replaceStoredAsset({
      storage: this.storage,
      logger: this.logger,
      previousPublicId: profile.photoPublicId,
      persist: () => this.playersService.setPhoto(profile.id, null),
    });

    await this.audit.record({
      action: AUDIT_CHILD_PHOTO_REMOVED,
      actor,
      target: { type: 'PlayerProfile', id: profile.id },
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

  /** Give a child profile its own login. See ChildAccountService. */
  async createChildLogin(
    actor: Principal,
    profileId: string,
    input: { email: string; password: string },
  ): Promise<ChildLoginView> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    return this.childAccounts.createLogin(actor, profile, input);
  }

  /** Revoke a child's login and every session using it. See ChildAccountService. */
  async revokeChildLogin(actor: Principal, profileId: string): Promise<void> {
    const profile = await this.requireOwnedProfile(actor.userId, profileId);
    await this.childAccounts.revokeLogin(actor, profile);
  }

  async childLoginStatus(parentUserId: string, profileId: string): Promise<ChildLoginStatusView> {
    const profile = await this.requireOwnedProfile(parentUserId, profileId);
    return this.childAccounts.loginStatus(profile);
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
