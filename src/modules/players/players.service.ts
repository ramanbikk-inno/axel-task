import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { EmergencyContact, PlayerProfile } from './entities/player-profile.entity';

export interface CreatePlayerProfileInput {
  ownerUserId: string;
  displayName: string;
  isChild?: boolean;
  birthDate?: string | null;
  gender?: string | null;
  school?: string | null;
  jerseyNumber?: string | null;
}

@Injectable()
export class PlayersService {
  constructor(
    @InjectRepository(PlayerProfile)
    private readonly profiles: Repository<PlayerProfile>,
  ) {}

  private repo(manager?: EntityManager): Repository<PlayerProfile> {
    return manager !== undefined ? manager.getRepository(PlayerProfile) : this.profiles;
  }

  async create(input: CreatePlayerProfileInput, manager?: EntityManager): Promise<PlayerProfile> {
    const repository = this.repo(manager);
    const profile = repository.create({
      ownerUserId: input.ownerUserId,
      displayName: input.displayName,
      isChild: input.isChild ?? false,
      birthDate: input.birthDate ?? null,
      gender: input.gender ?? null,
      school: input.school ?? null,
      jerseyNumber: input.jerseyNumber ?? null,
    });
    return repository.save(profile);
  }

  /** The account holder's own trainee profile (there is at most one). */
  async findSelfProfile(
    ownerUserId: string,
    manager?: EntityManager,
  ): Promise<PlayerProfile | null> {
    return this.repo(manager).findOne({ where: { ownerUserId, isChild: false } });
  }

  async findById(id: string, manager?: EntityManager): Promise<PlayerProfile | null> {
    return this.repo(manager).findOne({ where: { id } });
  }

  async findByIds(ids: string[]): Promise<PlayerProfile[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.profiles.find({ where: { id: In(ids) } });
  }

  /** Update the account holder's own (self) profile fields. */
  async updateSelfProfile(
    ownerUserId: string,
    input: {
      displayName?: string;
      school?: string | null;
      jerseyNumber?: string | null;
      gender?: string | null;
    },
  ): Promise<PlayerProfile | null> {
    const profile = await this.findSelfProfile(ownerUserId);
    if (!profile) {
      return null;
    }
    if (input.displayName !== undefined) {
      profile.displayName = input.displayName;
    }
    if (input.school !== undefined) {
      profile.school = input.school;
    }
    if (input.jerseyNumber !== undefined) {
      profile.jerseyNumber = input.jerseyNumber;
    }
    if (input.gender !== undefined) {
      profile.gender = input.gender;
    }
    return this.profiles.save(profile);
  }

  /**
   * Apply a partial update to a child profile.
   *
   * Only keys the caller actually supplied are written. `school`,
   * `jerseyNumber` and `emergencyContact` accept an explicit null, which is how
   * a parent clears one — hence the `undefined` check rather than a truthiness
   * test, which would silently ignore the clear.
   */
  async updateChildProfile(
    id: string,
    input: {
      displayName?: string;
      birthDate?: string;
      gender?: string;
      school?: string | null;
      jerseyNumber?: string | null;
      emergencyContact?: EmergencyContact | null;
    },
    manager?: EntityManager,
  ): Promise<PlayerProfile> {
    const repository = this.repo(manager);
    const patch: QueryDeepPartialEntity<PlayerProfile> = {};
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName;
    }
    if (input.birthDate !== undefined) {
      patch.birthDate = input.birthDate;
    }
    if (input.gender !== undefined) {
      patch.gender = input.gender;
    }
    if (input.school !== undefined) {
      patch.school = input.school;
    }
    if (input.jerseyNumber !== undefined) {
      patch.jerseyNumber = input.jerseyNumber;
    }
    if (input.emergencyContact !== undefined) {
      patch.emergencyContact = input.emergencyContact;
    }

    if (Object.keys(patch).length > 0) {
      await repository.update({ id }, patch);
    }
    return (await repository.findOne({ where: { id } })) as PlayerProfile;
  }

  /** Set the skill level a trainer assesses for a player. */
  async setSkillLevel(
    id: string,
    skillLevel: string | null,
    manager?: EntityManager,
  ): Promise<PlayerProfile> {
    const repository = this.repo(manager);
    await repository.update({ id }, { skillLevel });
    return (await repository.findOne({ where: { id } })) as PlayerProfile;
  }

  /** The PII an erasure has to clear off a trainee profile. */
  private static readonly ANONYMIZED_PROFILE = {
    displayName: 'Deleted User',
    school: null,
    jerseyNumber: null,
    gender: null,
    birthDate: null,
    // Third-party PII: an emergency contact is somebody else's name and
    // phone number, which has no business surviving this account.
    emergencyContact: null,
    skillLevel: null,
  } as const;

  /** GDPR anonymization of every profile owned by a user. */
  async anonymizeByOwner(ownerUserId: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager).update({ ownerUserId }, { ...PlayersService.ANONYMIZED_PROFILE });
  }

  /**
   * Anonymise the profile a child *login* belongs to. It is owned by the parent,
   * so `anonymizeByOwner` never matches it when the child's own account is the
   * one being erased.
   */
  async anonymizeByChildUserId(childUserId: string, manager?: EntityManager): Promise<void> {
    await this.repo(manager).update({ childUserId }, { ...PlayersService.ANONYMIZED_PROFILE });
  }

  /** The child login accounts attached to a user's profiles, if any. */
  async childUserIdsByOwner(ownerUserId: string, manager?: EntityManager): Promise<string[]> {
    const rows = await this.repo(manager).find({
      where: { ownerUserId },
      select: { id: true, childUserId: true },
    });
    return rows
      .map((r) => r.childUserId)
      .filter((id): id is string => id !== null && id !== undefined);
  }

  /** All profiles (self + children) owned by an account. */
  async findByOwner(ownerUserId: string, manager?: EntityManager): Promise<PlayerProfile[]> {
    return this.repo(manager).find({
      where: { ownerUserId },
      order: { isChild: 'ASC', createdAt: 'ASC' },
    });
  }
}
