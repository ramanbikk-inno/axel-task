import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainerProfile } from './entities/trainer-profile.entity';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface CreateTrainerProfileInput {
  userId: string;
  businessName: string;
  website?: string | null;
  address?: string | null;
  description?: string | null;
}

@Injectable()
export class TrainersService {
  constructor(
    @InjectRepository(TrainerProfile)
    private readonly trainersRepository: Repository<TrainerProfile>,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  async create(input: CreateTrainerProfileInput, manager?: EntityManager): Promise<TrainerProfile> {
    const repository: Repository<TrainerProfile> =
      manager !== undefined ? manager.getRepository(TrainerProfile) : this.trainersRepository;
    const profile: TrainerProfile = repository.create({
      userId: input.userId,
      businessName: input.businessName,
      website: input.website ?? null,
      address: input.address ?? null,
      description: input.description ?? null,
      stripeAccountId: null,
      subscriptionStatus: null,
      platformFeePercent: null,
    });
    return repository.save(profile);
  }

  async findByUserId(userId: string): Promise<TrainerProfile | null> {
    return this.trainersRepository.findOne({ where: { userId } });
  }

  async findById(id: string): Promise<TrainerProfile | null> {
    return this.trainersRepository.findOne({ where: { id } });
  }

  async findByIds(ids: string[]): Promise<TrainerProfile[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.trainersRepository.find({ where: { id: In(ids) } });
  }

  /** Update the trainer's own organization fields (US-01.11 role-specific). */
  async updateProfileByUserId(
    userId: string,
    input: {
      businessName?: string;
      website?: string | null;
      address?: string | null;
      description?: string | null;
    },
  ): Promise<TrainerProfile | null> {
    const profile = await this.findByUserId(userId);
    if (!profile) {
      return null;
    }
    if (input.businessName !== undefined) {
      profile.businessName = input.businessName;
    }
    if (input.website !== undefined) {
      profile.website = input.website;
    }
    if (input.address !== undefined) {
      profile.address = input.address;
    }
    if (input.description !== undefined) {
      profile.description = input.description;
    }
    return this.trainersRepository.save(profile);
  }

  /** Set the trainer's primary brand color (US-01.14). */
  async setPrimaryColor(userId: string, primaryColor: string): Promise<TrainerProfile> {
    const profile = await this.requireOwnProfile(userId);
    profile.primaryColor = primaryColor;
    return this.trainersRepository.save(profile);
  }

  /** Validate + store an uploaded logo, returning the updated profile (US-01.14). */
  async setLogoFromUpload(
    userId: string,
    input: { fileName: string; mimeType: string; dataBase64: string },
  ): Promise<TrainerProfile> {
    const profile = await this.requireOwnProfile(userId);

    const buffer = Buffer.from(input.dataBase64, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'Empty logo data.',
      });
    }
    if (buffer.length > MAX_LOGO_BYTES) {
      throw new BadRequestException({
        errorCode: ErrorCode.FILE_TOO_LARGE,
        message: 'Logo must be 2MB or smaller.',
      });
    }

    const { url } = await this.storage.upload({
      buffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
      folder: 'logos',
    });
    profile.logoUrl = url;
    return this.trainersRepository.save(profile);
  }

  private async requireOwnProfile(userId: string): Promise<TrainerProfile> {
    const profile = await this.findByUserId(userId);
    if (!profile) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return profile;
  }
}
