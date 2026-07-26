import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { decodeImageUpload } from '../../shared/files/image-content';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { MyProfileView } from './dto/my-profile.view';
import {
  UpdatePlayerProfileDto,
  UpdateProfileDto,
  UpdateTrainerProfileDto,
  UploadPhotoDto,
} from './dto/profile.dto';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

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
export const AUDIT_TRAINER_PROFILE_UPDATED = 'profile.trainer-updated';
export const AUDIT_PLAYER_PROFILE_UPDATED = 'profile.player-updated';

/** The field names that were actually supplied, for the audit metadata. */
function changedFields(dto: object): string[] {
  return Object.entries(dto)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly playersService: PlayersService,
    private readonly authService: AuthService,
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
      maxBytes: MAX_PHOTO_BYTES,
      label: 'Profile photo',
    });

    const previous = await this.requireUser(userId);
    const stored = await this.storage.upload({
      buffer,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      folder: 'avatars',
    });
    const user = await this.usersService.setPhoto(userId, stored);

    // Only after the row points at the new asset: deleting first would leave a
    // profile referencing nothing if the upload then failed.
    if (previous.photoPublicId !== null && previous.photoPublicId !== stored.publicId) {
      await this.discardAsset(previous.photoPublicId);
    }
    await this.audit.record({
      action: AUDIT_PROFILE_PHOTO_UPDATED,
      actor,
      targetUserId: userId,
      metadata: { fileName: dto.fileName },
    });
    return this.buildView(user);
  }

  /** Remove the photo and the stored asset behind it. */
  async removePhoto(actor: Principal): Promise<MyProfileView> {
    const existing = await this.requireUser(actor.userId);
    if (existing.photoUrl === null && existing.photoPublicId === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'There is no profile photo to remove.',
      });
    }

    const user = await this.usersService.setPhoto(actor.userId, null);
    if (existing.photoPublicId !== null) {
      await this.discardAsset(existing.photoPublicId);
    }
    await this.audit.record({
      action: AUDIT_PROFILE_PHOTO_REMOVED,
      actor,
      targetUserId: actor.userId,
    });
    return this.buildView(user);
  }

  async updateTrainer(actor: Principal, dto: UpdateTrainerProfileDto): Promise<MyProfileView> {
    const userId = actor.userId;
    const updated = await this.trainersService.updateProfileByUserId(userId, {
      businessName: dto.businessName,
      website: dto.website,
      address: dto.address,
      description: dto.description,
    });
    if (!updated) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    await this.audit.record({
      action: AUDIT_TRAINER_PROFILE_UPDATED,
      actor,
      targetUserId: userId,
      target: { type: 'TrainerProfile', id: updated.id },
      metadata: { fields: changedFields(dto) },
    });
    return this.getMe(userId);
  }

  async updatePlayer(actor: Principal, dto: UpdatePlayerProfileDto): Promise<MyProfileView> {
    const userId = actor.userId;
    const user = await this.requireUser(userId);
    if (dto.birthDate !== undefined) {
      // The same floor registration enforces. Without it, an account created as
      // an adult could be edited down to a minor's date afterwards.
      this.authService.assertOldEnoughForOwnAccount(dto.birthDate);
    }

    let profile = await this.playersService.updateSelfProfile(userId, {
      displayName: dto.displayName,
      school: dto.school,
      jerseyNumber: dto.jerseyNumber,
      gender: dto.gender,
      birthDate: dto.birthDate,
    });
    if (!profile) {
      // Only accounts predating registration-time profile creation reach this.
      profile = await this.playersService.create({
        ownerUserId: userId,
        displayName: dto.displayName ?? this.nameOf(user),
        isChild: false,
        school: dto.school ?? null,
        jerseyNumber: dto.jerseyNumber ?? null,
        gender: dto.gender ?? null,
        birthDate: dto.birthDate ?? null,
      });
    }
    await this.audit.record({
      action: AUDIT_PLAYER_PROFILE_UPDATED,
      actor,
      targetUserId: userId,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { fields: changedFields(dto) },
    });
    return this.getMe(userId);
  }

  /**
   * Cleanup is best-effort by construction. The row is already consistent by
   * the time this runs, so a storage outage should cost an orphaned file, not
   * the user's request. Kept here rather than relying on the storage
   * implementation to swallow its own errors — that is a property of one
   * implementation, not of the contract.
   */
  private async discardAsset(publicId: string): Promise<void> {
    try {
      await this.storage.delete(publicId);
    } catch (error) {
      this.logger.warn(
        `Orphaned stored asset ${publicId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async buildView(user: User): Promise<MyProfileView> {
    let trainer: TrainerProfile | null = null;
    let player: PlayerProfile | null = null;
    if (user.role === Role.Trainer) {
      trainer = await this.trainersService.findByUserId(user.id);
    }
    if (user.role === Role.PlayerParent) {
      player = await this.playersService.findSelfProfile(user.id);
    }
    return MyProfileView.build(user, trainer, player);
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
