import { Injectable, NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
import { displayNameFor } from '../../shared/format/display-name';
import { AuditService } from '../audit/audit.service';
import { ContextService } from '../auth/context.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { AssociationsService } from './associations.service';
import { RosterEntryView } from './dto/roster.dto';
import { AssociationStatus } from './entities/trainer-player-association.entity';

export const AUDIT_ROSTER_SKILL_LEVEL_SET = 'roster.skill-level-set';
export const AUDIT_ROSTER_MEMBER_REMOVED = 'roster.member-removed';

/**
 * The trainer-side roster (CRM): who is connected, their skill level, and
 * off-boarding. Joining is JoinService's; links are ShareLinksService's.
 */
@Injectable()
export class RosterService {
  constructor(
    private readonly usersService: UsersService,
    private readonly playersService: PlayersService,
    private readonly trainersService: TrainersService,
    private readonly associations: AssociationsService,
    private readonly audit: AuditService,
    private readonly context: ContextService,
  ) {}

  /**
   * The trainer's roster: every player profile connected to them.
   *
   * Scoped to the caller's own organisation, resolved from their user id — a
   * trainer cannot pass an org id and read someone else's roster, because
   * there is nowhere to pass one.
   */
  async list(
    principal: Principal,
    query: { search?: string; includeInactive?: boolean } = {},
  ): Promise<RosterEntryView[]> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);

    const associations = (await this.associations.findByTrainer(trainer.id)).filter(
      (a) => query.includeInactive === true || a.status === AssociationStatus.Active,
    );
    if (associations.length === 0) {
      return [];
    }

    const profiles = await this.playersService.findByIds(
      associations.map((a) => a.playerProfileId),
    );
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const accounts = await this.usersService.findByIds([
      ...new Set(profiles.map((p) => p.ownerUserId)),
    ]);
    const accountById = new Map(accounts.map((u) => [u.id, u]));

    const rows = associations
      .map((a) => {
        const profile = profileById.get(a.playerProfileId);
        if (!profile) {
          return null;
        }
        const account = accountById.get(profile.ownerUserId);
        return {
          playerProfileId: profile.id,
          displayName: profile.displayName,
          isChild: profile.isChild,
          birthDate: profile.birthDate,
          gender: profile.gender,
          skillLevel: profile.skillLevel,
          school: profile.school,
          jerseyNumber: profile.jerseyNumber,
          accountUserId: profile.ownerUserId,
          accountEmail: account?.email ?? null,
          accountName: account ? displayNameFor(account, account.email) : null,
          accountPhone: account?.phone ?? null,
          accountStatus: account?.status ?? null,
          status: a.status,
          connectedAt: a.connectedAt,
        };
      })
      .filter((r): r is RosterEntryView => r !== null);

    const search = query.search?.trim().toLowerCase();
    if (!search) {
      return rows;
    }
    return rows.filter((r) =>
      [r.displayName, r.accountEmail, r.accountName].some(
        (field) => field !== null && field.toLowerCase().includes(search),
      ),
    );
  }

  /**
   * The tenancy gate for every trainer-side write against a roster member.
   *
   * Resolves the caller's org and the association in one place, and reports a
   * player from another organisation as simply not on the roster — a 403 would
   * confirm the id names a real profile somewhere else.
   */
  private async requireRosterMember(
    principal: Principal,
    playerProfileId: string,
  ): Promise<{ trainerProfileId: string; profile: PlayerProfile }> {
    const trainer = await this.trainersService.requireOwnProfile(principal.userId);

    const association = await this.associations.find(trainer.id, playerProfileId);
    const profile = await this.playersService.findById(playerProfileId);
    if (!association || association.status !== AssociationStatus.Active || !profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This player is not on your roster.',
      });
    }
    return { trainerProfileId: trainer.id, profile };
  }

  /** Record the trainer's assessment of a player's skill level. */
  async setSkillLevel(
    principal: Principal,
    playerProfileId: string,
    skillLevel: string | null,
  ): Promise<RosterEntryView> {
    const { trainerProfileId, profile } = await this.requireRosterMember(
      principal,
      playerProfileId,
    );

    await this.playersService.setSkillLevel(profile.id, skillLevel);
    await this.audit.record({
      action: AUDIT_ROSTER_SKILL_LEVEL_SET,
      actor: principal,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { trainerProfileId, skillLevel },
    });

    const entry = (await this.list(principal)).find((r) => r.playerProfileId === profile.id);
    if (!entry) {
      // Unreachable: requireRosterMember just proved the association is active.
      throw new NotFoundException({
        errorCode: ErrorCode.NOT_FOUND,
        message: 'This player is not on your roster.',
      });
    }
    return entry;
  }

  /**
   * Remove a player from the trainer's own roster.
   *
   * Deactivated rather than deleted, matching the family-side removal in
   * mirroring the family-side removal: history is preserved and the pairing can
   * be re-established. Until this existed only the family could sever the link,
   * so a trainer had no way to off-board a player who had left.
   */
  async remove(principal: Principal, playerProfileId: string): Promise<void> {
    const { trainerProfileId, profile } = await this.requireRosterMember(
      principal,
      playerProfileId,
    );

    await this.associations.setStatus(trainerProfileId, profile.id, AssociationStatus.Inactive);
    // A session parked in this context now points at a trainer the profile is
    // no longer connected to, exactly as on the family side.
    await this.context.clearForAssociation(profile.id, trainerProfileId);

    await this.audit.record({
      action: AUDIT_ROSTER_MEMBER_REMOVED,
      actor: principal,
      target: { type: 'PlayerProfile', id: profile.id },
      metadata: { trainerProfileId },
    });
  }
}
