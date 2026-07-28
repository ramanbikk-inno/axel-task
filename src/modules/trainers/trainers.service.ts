import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { decodeImageUpload, MAX_IMAGE_UPLOAD_BYTES } from '../../shared/files/image-content';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../enrollment/entities/trainer-player-association.entity';
import { PlayersService } from '../players/players.service';
import { discardAsset } from '../storage/discard-asset';
import { STORAGE, StorageService } from '../storage/storage.service';
import { Role } from '../users/entities/user.enums';
import { TrainerProfile } from './entities/trainer-profile.entity';

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
    @InjectRepository(TrainerPlayerAssociation)
    private readonly associations: Repository<TrainerPlayerAssociation>,
    private readonly playersService: PlayersService,
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

  /**
   * Branding by id, scoped to organisation members — a competing trainer or an
   * unaffiliated player must not resolve another org's id. 404, not 403, so the
   * reply gives nothing away either way.
   */
  async findAccessibleById(principal: Principal, id: string): Promise<TrainerProfile> {
    const profile = await this.findById(id);
    if (!profile || !(await this.isOrgMember(principal, id))) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'Trainer not found.',
      });
    }
    return profile;
  }

  /**
   * Is this principal inside the named organisation? Mirrors
   * CoachesService.isOrgMember — each service owning a tenant-scoped resource
   * runs its own check against the principal, per the pattern this repo already
   * uses for coach visibility.
   */
  private async isOrgMember(principal: Principal, trainerProfileId: string): Promise<boolean> {
    if (principal.role === Role.SuperAdmin) {
      return true;
    }
    if (principal.role === Role.Trainer || principal.role === Role.Coach) {
      return principal.trainerOrgId === trainerProfileId;
    }

    // A child login sees only the one profile it is, never a sibling's.
    const profileIds = principal.isChild
      ? principal.childPlayerProfileId === null
        ? []
        : [principal.childPlayerProfileId]
      : (await this.playersService.findByOwner(principal.userId)).map((p) => p.id);
    if (profileIds.length === 0) {
      return false;
    }

    const count = await this.associations.count({
      where: {
        trainerProfileId,
        playerProfileId: In(profileIds),
        status: AssociationStatus.Active,
      },
    });
    return count > 0;
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
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
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
      await discardAsset(this.storage, previousPublicId, this.logger);
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
      await discardAsset(this.storage, previousPublicId, this.logger);
    }
    await this.audit.record({
      action: AUDIT_BRANDING_LOGO_REMOVED,
      actor,
      target: { type: 'TrainerOrg', id: profile.id },
    });
    return saved;
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
