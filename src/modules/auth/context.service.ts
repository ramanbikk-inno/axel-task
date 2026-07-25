import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../enrollment/entities/trainer-player-association.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { AuthSession } from './entities/auth-session.entity';
import { Principal } from './principal';

export interface ContextOption {
  playerProfileId: string;
  playerDisplayName: string;
  isChild: boolean;
  trainerProfileId: string;
  trainerBusinessName: string;
}

export interface ActiveContext {
  playerProfileId: string;
  trainerProfileId: string;
}

@Injectable()
export class ContextService {
  constructor(
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(PlayerProfile) private readonly profiles: Repository<PlayerProfile>,
    @InjectRepository(TrainerProfile) private readonly trainers: Repository<TrainerProfile>,
    @InjectRepository(TrainerPlayerAssociation)
    private readonly associations: Repository<TrainerPlayerAssociation>,
  ) {}

  /**
   * The profiles this principal is allowed to look through.
   *
   * Keyed on `principal.userId` and nothing the caller supplied — that is the
   * whole tenancy boundary for context switching. A parent sees their own
   * profile and their children's; anyone else sees none, because switching
   * contexts is a player/parent affordance (a Coach's tenancy comes from their
   * employer, not from a selection they make).
   */
  private async switchableProfiles(principal: Principal): Promise<PlayerProfile[]> {
    // US-01.06: "Context selector shows only child's own trainer contexts (no
    // parent data)." A child's profile is owned by the parent, so the owner
    // clause below would match the *parent's* whole family for them — hence
    // the separate branch keyed on the one profile this login is.
    if (principal.isChild) {
      return principal.childPlayerProfileId === null
        ? []
        : this.profiles.find({ where: { id: principal.childPlayerProfileId } });
    }
    return this.profiles.find({
      where: { ownerUserId: principal.userId },
      order: { isChild: 'ASC', displayName: 'ASC' },
    });
  }

  /**
   * Every (profile, trainer) pair the principal may switch to, which is exactly
   * what the context selector in US-01.04 renders.
   */
  async listOptions(principal: Principal): Promise<ContextOption[]> {
    const profiles = await this.switchableProfiles(principal);
    if (profiles.length === 0) {
      return [];
    }

    const links = await this.associations.find({
      where: profiles.map((p) => ({
        playerProfileId: p.id,
        status: AssociationStatus.Active,
      })),
    });
    if (links.length === 0) {
      return [];
    }

    const trainerIds = [...new Set(links.map((l) => l.trainerProfileId))];
    const trainers = await this.trainers.find({ where: trainerIds.map((id) => ({ id })) });
    const trainerById = new Map(trainers.map((t) => [t.id, t]));
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    const options: ContextOption[] = [];
    for (const profile of profiles) {
      for (const link of links.filter((l) => l.playerProfileId === profile.id)) {
        const trainer = trainerById.get(link.trainerProfileId);
        const owner = profileById.get(link.playerProfileId);
        if (!trainer || !owner) {
          continue;
        }
        options.push({
          playerProfileId: owner.id,
          playerDisplayName: owner.displayName,
          isChild: owner.isChild,
          trainerProfileId: trainer.id,
          trainerBusinessName: trainer.businessName,
        });
      }
    }
    return options;
  }

  /**
   * Switch the session's active context.
   *
   * Written to the session row rather than only into a token, so it survives a
   * refresh and so revoking the session revokes the context with it. The
   * caller gets a new access token because the claims change.
   */
  async switch(principal: Principal, target: ActiveContext): Promise<ActiveContext> {
    // Resolved through the same allow-list the selector renders, so a child
    // cannot name a sibling's profile id and a parent cannot name a stranger's.
    const allowed = await this.switchableProfiles(principal);
    const profile = allowed.find((p) => p.id === target.playerProfileId) ?? null;
    if (!profile) {
      // 404, not 403: a parent must not be able to tell a profile that exists
      // and belongs to someone else from one that does not exist.
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Profile not found.',
      });
    }

    const association = await this.associations.findOne({
      where: {
        playerProfileId: profile.id,
        trainerProfileId: target.trainerProfileId,
        status: AssociationStatus.Active,
      },
    });
    if (!association) {
      throw new ForbiddenException({
        errorCode: ErrorCode.TRAINER_NOT_ASSOCIATED,
        message: 'That profile is not actively associated with this trainer.',
      });
    }

    await this.sessions.update(
      { id: principal.sessionId },
      {
        activePlayerProfileId: profile.id,
        activeTrainerProfileId: association.trainerProfileId,
      },
    );

    return {
      playerProfileId: profile.id,
      trainerProfileId: association.trainerProfileId,
    };
  }

  /** Drop back to no selection. Always allowed; there is nothing to authorise. */
  async clear(principal: Principal): Promise<void> {
    await this.sessions.update(
      { id: principal.sessionId },
      { activePlayerProfileId: null, activeTrainerProfileId: null },
    );
  }

  /**
   * Drop this context out of every session currently sitting in it.
   *
   * Called when the association behind it is deactivated. Without this the
   * session keeps naming a trainer the profile is no longer connected to, and
   * everything scoped to the active context stays pointed at data the caller
   * has just been disconnected from — until they happen to switch again.
   */
  async clearForAssociation(playerProfileId: string, trainerProfileId: string): Promise<void> {
    await this.sessions.update(
      { activePlayerProfileId: playerProfileId, activeTrainerProfileId: trainerProfileId },
      { activePlayerProfileId: null, activeTrainerProfileId: null },
    );
  }
}
