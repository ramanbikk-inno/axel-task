import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

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

  /** All profiles (self + children) owned by an account. */
  async findByOwner(ownerUserId: string, manager?: EntityManager): Promise<PlayerProfile[]> {
    return this.repo(manager).find({
      where: { ownerUserId },
      order: { isChild: 'ASC', createdAt: 'ASC' },
    });
  }
}
