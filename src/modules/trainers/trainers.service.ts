import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { repoFor } from '../../shared/database/repo-for';
import { ErrorCode } from '../../shared/errors/error-codes';
import { decodeImageUpload, MAX_IMAGE_UPLOAD_BYTES } from '../../shared/files/image-content';
import { AuditService } from '../audit/audit.service';
import { changedFields } from '../audit/changed-fields';
import { Principal } from '../auth/principal';
import { OrgMembershipService } from '../org-membership/org-membership.service';
import { replaceStoredAsset } from '../storage/replace-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { TrainerProfile } from './entities/trainer-profile.entity';

export const AUDIT_BRANDING_COLOR_SET = 'trainer.branding-color-set';
export const AUDIT_BRANDING_LOGO_SET = 'trainer.branding-logo-set';
export const AUDIT_BRANDING_LOGO_REMOVED = 'trainer.branding-logo-removed';

/**
 * Same value as ProfileService's constant of the same name. Declared here too
 * because trainers cannot import profile — profile already imports trainers.
 */
export const AUDIT_TRAINER_PROFILE_UPDATED = 'profile.trainer-updated';

export interface CreateTrainerProfileInput {
  userId: string;
  businessName: string;
  website?: string | null;
  address?: string | null;
  description?: string | null;
}

/** The organisation fields both the self-service and admin routes may patch. */
export interface UpdateTrainerProfileFields {
  businessName?: string;
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
    private readonly orgMembership: OrgMembershipService,
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateTrainerProfileInput, manager?: EntityManager): Promise<TrainerProfile> {
    const repository = repoFor(this.trainersRepository, TrainerProfile, manager);
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

  /**
   * Branding by id, scoped to organisation members — a competing trainer or an
   * unaffiliated player must not resolve another org's id. 404, not 403, so the
   * reply gives nothing away either way.
   */
  async findAccessibleById(principal: Principal, id: string): Promise<TrainerProfile> {
    const profile = await this.findById(id);
    if (!profile || !(await this.orgMembership.isOrgMember(principal, id))) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'Trainer not found.',
      });
    }
    return profile;
  }

  async findByIds(ids: string[]): Promise<TrainerProfile[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.trainersRepository.find({ where: { id: In(ids) } });
  }

  /**
   * Update + audit in one place, for the self-service and admin routes alike.
   * The caller resolves the profile, so each keeps its own not-found status.
   */
  async applyProfileUpdate(
    profile: TrainerProfile,
    input: UpdateTrainerProfileFields,
    actor: Principal,
    manager?: EntityManager,
  ): Promise<TrainerProfile> {
    TrainersService.assignProfileFields(profile, input);
    const saved = await repoFor(this.trainersRepository, TrainerProfile, manager).save(profile);
    await this.audit.record(
      {
        action: AUDIT_TRAINER_PROFILE_UPDATED,
        actor,
        targetUserId: saved.userId,
        target: { type: 'TrainerProfile', id: saved.id },
        metadata: { fields: changedFields(input) },
      },
      manager,
    );
    return saved;
  }

  /** Only keys the caller supplied are written; null clears a nullable field. */
  private static assignProfileFields(
    profile: TrainerProfile,
    input: UpdateTrainerProfileFields,
  ): void {
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
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
      label: 'Logo',
    });

    const previousPublicId = profile.logoPublicId;
    const { persisted: saved } = await replaceStoredAsset({
      storage: this.storage,
      logger: this.logger,
      previousPublicId,
      upload: { buffer, fileName: input.fileName, mimeType: input.mimeType, folder: 'logos' },
      persist: (uploaded) => {
        profile.logoUrl = uploaded?.url ?? null;
        profile.logoPublicId = uploaded?.publicId ?? null;
        return this.trainersRepository.save(profile);
      },
    });

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

    const { persisted: saved } = await replaceStoredAsset({
      storage: this.storage,
      logger: this.logger,
      previousPublicId: profile.logoPublicId,
      persist: () => {
        profile.logoUrl = null;
        profile.logoPublicId = null;
        return this.trainersRepository.save(profile);
      },
    });

    await this.audit.record({
      action: AUDIT_BRANDING_LOGO_REMOVED,
      actor,
      target: { type: 'TrainerOrg', id: profile.id },
    });
    return saved;
  }

  /**
   * The caller's own trainer profile, or 403. Shared by every service that acts
   * on "the trainer behind this request" — not for lookups by id, where a 404
   * keeps another org's existence hidden (see `findAccessibleById`).
   */
  async requireOwnProfile(userId: string): Promise<TrainerProfile> {
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
