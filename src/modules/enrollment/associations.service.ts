import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from './entities/trainer-player-association.entity';

export interface AssociateInput {
  trainerProfileId: string;
  playerProfileId: string;
  shareLinkId?: string | null;
}

export interface AssociateResult {
  association: TrainerPlayerAssociation;
  created: boolean;
}

@Injectable()
export class AssociationsService {
  constructor(
    @InjectRepository(TrainerPlayerAssociation)
    private readonly associations: Repository<TrainerPlayerAssociation>,
    private readonly clock: ClockService,
  ) {}

  private repo(manager?: EntityManager): Repository<TrainerPlayerAssociation> {
    return manager !== undefined
      ? manager.getRepository(TrainerPlayerAssociation)
      : this.associations;
  }

  async find(
    trainerProfileId: string,
    playerProfileId: string,
    manager?: EntityManager,
  ): Promise<TrainerPlayerAssociation | null> {
    return this.repo(manager).findOne({ where: { trainerProfileId, playerProfileId } });
  }

  /**
   * Idempotently connect a player profile to a trainer. Re-connecting an
   * inactive association reactivates it; an already-active one is returned
   * unchanged. Never creates a duplicate (enforced by a unique index too).
   */
  async associate(input: AssociateInput, manager?: EntityManager): Promise<AssociateResult> {
    const existing = await this.find(input.trainerProfileId, input.playerProfileId, manager);
    if (existing) {
      if (existing.status !== AssociationStatus.Active) {
        existing.status = AssociationStatus.Active;
        existing.connectedAt = this.clock.now();
        if (input.shareLinkId) {
          existing.shareLinkId = input.shareLinkId;
        }
        const saved = await this.repo(manager).save(existing);
        return { association: saved, created: false };
      }
      return { association: existing, created: false };
    }

    const repository = this.repo(manager);
    const created = repository.create({
      trainerProfileId: input.trainerProfileId,
      playerProfileId: input.playerProfileId,
      shareLinkId: input.shareLinkId ?? null,
      status: AssociationStatus.Active,
      connectedAt: this.clock.now(),
    });
    const saved = await repository.save(created);
    return { association: saved, created: true };
  }

  /**
   * Set the status of an existing association (e.g. deactivate to disconnect a
   * player from a trainer while preserving history). Returns null if none.
   */
  async setStatus(
    trainerProfileId: string,
    playerProfileId: string,
    status: AssociationStatus,
    manager?: EntityManager,
  ): Promise<TrainerPlayerAssociation | null> {
    const existing = await this.find(trainerProfileId, playerProfileId, manager);
    if (!existing) {
      return null;
    }
    existing.status = status;
    return this.repo(manager).save(existing);
  }

  /** Player profiles connected to a trainer's organization. */
  async findByTrainer(trainerProfileId: string): Promise<TrainerPlayerAssociation[]> {
    return this.repo().find({
      where: { trainerProfileId },
      order: { connectedAt: 'DESC' },
    });
  }

  /** Trainers a set of player profiles are connected to. */
  async findByPlayerProfiles(playerProfileIds: string[]): Promise<TrainerPlayerAssociation[]> {
    if (playerProfileIds.length === 0) {
      return [];
    }
    return this.repo()
      .createQueryBuilder('a')
      .where('a.player_profile_id IN (:...ids)', { ids: playerProfileIds })
      .orderBy('a.connected_at', 'DESC')
      .getMany();
  }
}
