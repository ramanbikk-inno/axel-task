import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
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

@Injectable()
export class ProfileService {
  constructor(
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly playersService: PlayersService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  async getMe(userId: string): Promise<MyProfileView> {
    const user = await this.requireUser(userId);
    return this.buildView(user);
  }

  async updateCommon(userId: string, dto: UpdateProfileDto): Promise<MyProfileView> {
    await this.requireUser(userId);
    const user = await this.usersService.updateProfile(userId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
    });
    return this.buildView(user);
  }

  async uploadPhoto(userId: string, dto: UploadPhotoDto): Promise<MyProfileView> {
    await this.requireUser(userId);

    // Verifies the bytes really are an image of the declared type — the
    // client-supplied mimeType alone would let a script through as image/png.
    const { buffer } = decodeImageUpload({
      dataBase64: dto.dataBase64,
      declaredMimeType: dto.mimeType,
      maxBytes: MAX_PHOTO_BYTES,
      label: 'Profile photo',
    });

    const { url } = await this.storage.upload({
      buffer,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      folder: 'avatars',
    });
    const user = await this.usersService.setPhotoUrl(userId, url);
    return this.buildView(user);
  }

  async updateTrainer(userId: string, dto: UpdateTrainerProfileDto): Promise<MyProfileView> {
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
    return this.getMe(userId);
  }

  async updatePlayer(userId: string, dto: UpdatePlayerProfileDto): Promise<MyProfileView> {
    const user = await this.requireUser(userId);
    let profile = await this.playersService.updateSelfProfile(userId, {
      displayName: dto.displayName,
      school: dto.school,
      jerseyNumber: dto.jerseyNumber,
      gender: dto.gender,
    });
    if (!profile) {
      // No self profile yet (e.g. registered without a ShareLink) — create one.
      profile = await this.playersService.create({
        ownerUserId: userId,
        displayName: dto.displayName ?? this.nameOf(user),
        isChild: false,
        school: dto.school ?? null,
        jerseyNumber: dto.jerseyNumber ?? null,
        gender: dto.gender ?? null,
      });
    }
    return this.getMe(userId);
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
