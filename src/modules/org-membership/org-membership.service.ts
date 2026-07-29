import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Principal } from '../auth/principal';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../enrollment/entities/trainer-player-association.entity';
import { PlayersService } from '../players/players.service';
import { Role } from '../users/entities/user.enums';

/**
 * The one answer to "is this principal inside that trainer organisation?".
 * Trainers and coaches each carried their own copy of this check and had already
 * drifted apart — one filtered active associations in the database, the other in
 * memory — so the same authorization question could get two answers.
 */
@Injectable()
export class OrgMembershipService {
  constructor(
    @InjectRepository(TrainerPlayerAssociation)
    private readonly associations: Repository<TrainerPlayerAssociation>,
    private readonly playersService: PlayersService,
  ) {}

  async isOrgMember(principal: Principal, trainerProfileId: string): Promise<boolean> {
    if (principal.role === Role.SuperAdmin) {
      return true;
    }
    // `trainerOrgId` is already resolved per request — own org for a Trainer,
    // employer's for a Coach, null once an engagement ends — so compare against
    // it rather than re-deriving it.
    if (principal.role === Role.Trainer || principal.role === Role.Coach) {
      return principal.trainerOrgId === trainerProfileId;
    }

    const profileIds = await this.playerProfileIds(principal);
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

  /** A child login sees only the one profile it is, never a sibling's. */
  private async playerProfileIds(principal: Principal): Promise<string[]> {
    if (principal.isChild) {
      return principal.childPlayerProfileId === null ? [] : [principal.childPlayerProfileId];
    }
    return (await this.playersService.findByOwner(principal.userId)).map((p) => p.id);
  }
}
