import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AgeGateService } from '../../shared/registration/age-gate.service';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { AUDIT_PLAYER_PROFILE_UPDATED, PlayersService } from '../players/players.service';
import { decodeImageUpload, MAX_IMAGE_UPLOAD_BYTES } from '../../shared/files/image-content';
import { discardAsset } from '../storage/discard-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { MyProfileView } from './dto/my-profile.view';
import {
  UpdateOwnChildProfileDto,
  UpdatePlayerProfileDto,
  UpdateProfileDto,
  UpdateTrainerProfileDto,
  UploadPhotoDto,
} from './dto/profile.dto';

/**
 * Every action taken during an impersonation has to be
 * attributable to the admin behind it. Self-service profile edits were not
 * audited at all, so an admin could change a user's name, phone or photo while
 * impersonating them and leave nothing behind — the one place the requirement
 * most obviously applies, since these are exactly the endpoints an
 * impersonation session can reach.
 */
export const AUDIT_PROFILE_UPDATED = 'profile.updated';
export const AUDIT_PROFILE_PHOTO_UPDATED = 'profile.photo-updated';
export const AUDIT_PROFILE_PHOTO_REMOVED = 'profile.photo-removed';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly playersService: PlayersService,
    private readonly ageGate: AgeGateService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async getMe(userId: string): Promise<MyProfileView> {
    const user = await this.requireUser(userId);
    return this.buildView(user);
  }

  async updateCommon(actor: Principal, dto: UpdateProfileDto): Promise<MyProfileView> {
    await this.requireUser(actor.userId);
    const user = await this.usersService.updateProfile(actor.userId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
    });
    await this.audit.record({
      action: AUDIT_PROFILE_UPDATED,
      actor,
      targetUserId: actor.userId,
      metadata: { fields: changedFields(dto) },
    });
    return this.buildView(user);
  }

  async uploadPhoto(actor: Principal, dto: UploadPhotoDto): Promise<MyProfileView> {
    const userId = actor.userId;
    await this.requireUser(userId);

    // Verifies the bytes really are an image of the declared type — the
    // client-supplied mimeType alone would let a script through as image/png.
    const { buffer } = decodeImageUpload({
      dataBase64: dto.dataBase64,
      declaredMimeType: dto.mimeType,
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
      label: 'Profile photo',
    });

    // A child's photo belongs on their player profile, not on `users`.
    const childProfileId = actor.isChild ? this.requireChildProfileId(actor) : null;
    const previousPublicId =
      childProfileId === null
        ? (await this.requireUser(userId)).photoPublicId
        : (await this.loadChildProfile(childProfileId)).photoPublicId;

    const stored = await this.storage.upload({
      buffer,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      folder: 'avatars',
    });
    if (childProfileId === null) {
      await this.usersService.setPhoto(userId, stored);
    } else {
      await this.playersService.setPhoto(childProfileId, stored);
    }

    // Only after the row points at the new asset: deleting first would leave a
    // profile referencing nothing if the upload then failed.
    if (previousPublicId !== null && previousPublicId !== stored.publicId) {
      await discardAsset(this.storage, previousPublicId, this.logger);
    }
    await this.audit.record({
      action: AUDIT_PROFILE_PHOTO_UPDATED,
      actor,
      targetUserId: userId,
      ...(childProfileId === null
        ? {}
        : { target: { type: 'PlayerProfile' as const, id: childProfileId } }),
      metadata: { fileName: dto.fileName },
    });
    return this.getMe(userId);
  }

  /** Remove the photo and the stored asset behind it. */
  async removePhoto(actor: Principal): Promise<MyProfileView> {
    const childProfileId = actor.isChild ? this.requireChildProfileId(actor) : null;
    const existing =
      childProfileId === null
        ? await this.requireUser(actor.userId)
        : await this.loadChildProfile(childProfileId);

    if (existing.photoUrl === null && existing.photoPublicId === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'There is no profile photo to remove.',
      });
    }

    if (childProfileId === null) {
      await this.usersService.setPhoto(actor.userId, null);
    } else {
      await this.playersService.setPhoto(childProfileId, null);
    }
    if (existing.photoPublicId !== null) {
      await discardAsset(this.storage, existing.photoPublicId, this.logger);
    }
    await this.audit.record({
      action: AUDIT_PROFILE_PHOTO_REMOVED,
      actor,
      targetUserId: actor.userId,
      ...(childProfileId === null
        ? {}
        : { target: { type: 'PlayerProfile' as const, id: childProfileId } }),
    });
    return this.getMe(actor.userId);
  }

  private async loadChildProfile(profileId: string): Promise<PlayerProfile> {
    const profile = await this.playersService.findById(profileId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND,
        message: 'Player profile not found.',
      });
    }
    return profile;
  }

  async updateTrainer(actor: Principal, dto: UpdateTrainerProfileDto): Promise<MyProfileView> {
    const userId = actor.userId;
    const profile = await this.trainersService.findByUserId(userId);
    if (!profile) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    await this.trainersService.applyProfileUpdate(
      profile,
      {
        businessName: dto.businessName,
        website: dto.website,
        address: dto.address,
        description: dto.description,
      },
      actor,
    );
    return this.getMe(userId);
  }

  async updatePlayer(actor: Principal, dto: UpdatePlayerProfileDto): Promise<MyProfileView> {
    // Also guarded on the route. Kept here because the fallback below creates a
    // profile when the caller has none, and a child must never get one — nor
    // move their own birth date, which is what the age gate reads.
    if (actor.isChild) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CHILD_ACTION_NOT_ALLOWED,
        message: 'Ask your parent to do this for you.',
      });
    }

    const userId = actor.userId;
    const user = await this.requireUser(userId);
    if (dto.birthDate !== undefined) {
      // The same floor registration enforces. Without it, an account created as
      // an adult could be edited down to a minor's date afterwards.
      this.ageGate.assertOldEnoughForOwnAccount(dto.birthDate);
    }

    const existing = await this.playersService.findSelfProfile(userId);
    if (existing) {
      await this.playersService.applyProfileUpdate(
        existing,
        {
          displayName: dto.displayName,
          school: dto.school,
          jerseyNumber: dto.jerseyNumber,
          gender: dto.gender,
          birthDate: dto.birthDate,
          emergencyContact: dto.emergencyContact,
        },
        actor,
      );
    } else {
      // Only accounts predating registration-time profile creation reach this.
      const created = await this.playersService.create({
        ownerUserId: userId,
        displayName: dto.displayName ?? this.nameOf(user),
        isChild: false,
        school: dto.school ?? null,
        jerseyNumber: dto.jerseyNumber ?? null,
        gender: dto.gender ?? null,
        birthDate: dto.birthDate ?? null,
        emergencyContact: dto.emergencyContact ?? null,
      });
      await this.audit.record({
        action: AUDIT_PLAYER_PROFILE_UPDATED,
        actor,
        targetUserId: userId,
        target: { type: 'PlayerProfile', id: created.id },
        metadata: { fields: changedFields(dto) },
      });
    }
    return this.getMe(userId);
  }

  async updateOwnChildProfile(
    actor: Principal,
    dto: UpdateOwnChildProfileDto,
  ): Promise<MyProfileView> {
    const profileId = this.requireChildProfileId(actor);
    const updated = await this.playersService.updateChildProfile(profileId, {
      school: dto.school,
      jerseyNumber: dto.jerseyNumber,
    });
    await this.audit.record({
      action: AUDIT_PLAYER_PROFILE_UPDATED,
      actor,
      targetUserId: actor.userId,
      target: { type: 'PlayerProfile', id: updated.id },
      metadata: { fields: changedFields(dto) },
    });
    return this.getMe(actor.userId);
  }

  private requireChildProfileId(actor: Principal): string {
    if (!actor.isChild || actor.childPlayerProfileId === null) {
      throw new ForbiddenException({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
        message: 'This endpoint is for child logins. Use /profile/me/player instead.',
      });
    }
    return actor.childPlayerProfileId;
  }

  private async buildView(user: User): Promise<MyProfileView> {
    let trainer: TrainerProfile | null = null;
    let player: PlayerProfile | null = null;
    if (user.role === Role.Trainer) {
      trainer = await this.trainersService.findByUserId(user.id);
    }
    if (user.role === Role.PlayerParent) {
      player = await this.traineeProfileFor(user.id);
    }
    return MyProfileView.build(user, trainer, player);
  }

  /** For a child login, `ownerUserId` finds nothing — their profile is the parent's. */
  private async traineeProfileFor(userId: string): Promise<PlayerProfile | null> {
    const own = await this.playersService.findSelfProfile(userId);
    return own ?? (await this.playersService.findByChildUserId(userId));
  }

  private nameOf(user: User): string {
    const full = [user.firstName, user.lastName]
      .filter((v) => v !== null && v !== undefined && v.trim() !== '')
      .join(' ');
    return full !== '' ? full : user.email;
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException({ errorCode: ErrorCode.NOT_FOUND, message: 'User not found.' });
    }
    return user;
  }
}
