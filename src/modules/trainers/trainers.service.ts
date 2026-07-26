import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { decodeImageUpload } from '../../shared/files/image-content';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainerProfile } from './entities/trainer-profile.entity';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const AUDIT_BRANDING_COLOR_SET = 'trainer.branding-color-set';
export const AUDIT_BRANDING_LOGO_SET = 'trainer.branding-logo-set';
export const AUDIT_BRANDING_LOGO_REMOVED = 'trainer.branding-logo-removed';

export interface CreateTrainerProfileInput {
  userId: string;
  businessName: string;
  website?: string | null;
  address?: string | null;
  description?: string | null;
}

@Injectable()
export class TrainersService {
  private readonly logger = new Logger(TrainersService.name);

  constructor(
    @InjectRepository(TrainerProfile)
    private readonly trainersRepository: Repository<TrainerProfile>,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly audit: AuditService,
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

  /** Update the trainer's own organization fields (role-specific). */
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

  /** Set the trainer's primary brand color. */
  async setPrimaryColor(actor: Principal, primaryColor: string | null): Promise<TrainerProfile> {
    const profile = await this.requireOwnProfile(actor.userId);
    profile.primaryColor = primaryColor;
    const saved = await this.trainersRepository.save(profile);
    await this.audit.record({
      action: AUDIT_BRANDING_COLOR_SET,
      actor,
      target: { type: 'TrainerOrg', id: profile.id },
      metadata: { primaryColor },
    });
    return saved;
  }

  /** Validate + store an uploaded logo, returning the updated profile. */
  async setLogoFromUpload(
    actor: Principal,
    input: { fileName: string; mimeType: string; dataBase64: string },
  ): Promise<TrainerProfile> {
    const profile = await this.requireOwnProfile(actor.userId);

    const { buffer } = decodeImageUpload({
      dataBase64: input.dataBase64,
      declaredMimeType: input.mimeType,
      maxBytes: MAX_LOGO_BYTES,
      label: 'Logo',
    });

    const previousPublicId = profile.logoPublicId;
    const stored = await this.storage.upload({
      buffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
      folder: 'logos',
    });
    profile.logoUrl = stored.url;
    profile.logoPublicId = stored.publicId;
    const saved = await this.trainersRepository.save(profile);

    // After the row points at the new asset, never before: deleting first
    // would leave the profile referencing nothing if the upload then failed.
    if (previousPublicId !== null && previousPublicId !== stored.publicId) {
      await this.discardAsset(previousPublicId);
    }
    await this.audit.record({
      action: AUDIT_BRANDING_LOGO_SET,
      actor,
      target: { type: 'TrainerOrg', id: profile.id },
      metadata: { replacedPrevious: previousPublicId !== null },
    });
    return saved;
  }

  /** Remove the logo and the stored asset behind it. */
  async removeLogo(actor: Principal): Promise<TrainerProfile> {
    const profile = await this.requireOwnProfile(actor.userId);
    if (profile.logoUrl === null && profile.logoPublicId === null) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'There is no logo to remove.',
      });
    }

    const previousPublicId = profile.logoPublicId;
    profile.logoUrl = null;
    profile.logoPublicId = null;
    const saved = await this.trainersRepository.save(profile);
    if (previousPublicId !== null) {
      await this.discardAsset(previousPublicId);
    }
    await this.audit.record({
      action: AUDIT_BRANDING_LOGO_REMOVED,
      actor,
      target: { type: 'TrainerOrg', id: profile.id },
    });
    return saved;
  }

  /** Best-effort: the row is already consistent, so an outage costs an orphan. */
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
