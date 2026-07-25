import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { PlayerProfile } from './entities/player-profile.entity';

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

  /** Update the account holder's own (self) profile fields (US-01.11). */
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

  /** GDPR anonymization of every profile owned by a user (US-01.13). */
  async anonymizeByOwner(ownerUserId: string, manager?: EntityManager): Promise<void> {
    const repository = this.repo(manager);
    await repository.update(
      { ownerUserId },
      {
        displayName: 'Deleted User',
        school: null,
        jerseyNumber: null,
        gender: null,
        birthDate: null,
        // Third-party PII: an emergency contact is somebody else's name and
        // phone number, which has no business surviving this account.
        emergencyContact: null,
        skillLevel: null,
      },
    );
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
