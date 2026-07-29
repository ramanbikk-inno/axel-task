import { NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { ContextService } from '../auth/context.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { AssociationsService } from './associations.service';
import { RosterEntryView } from './dto/roster.dto';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from './entities/trainer-player-association.entity';
import {
  AUDIT_ROSTER_MEMBER_REMOVED,
  AUDIT_ROSTER_SKILL_LEVEL_SET,
  RosterService,
} from './roster.service';

const TRAINER_ID = 'trainer-profile-1';
const NOT_ON_ROSTER = {
  response: { errorCode: ErrorCode.NOT_FOUND, message: 'This player is not on your roster.' },
};

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    role: Role.Trainer,
    sessionId: 'session-1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: 'trainer',
    impersonating: false,
    ...over,
  };
}

const trainerProfile = (id = TRAINER_ID): TrainerProfile => ({ id }) as TrainerProfile;

const association = (over: Partial<TrainerPlayerAssociation> = {}): TrainerPlayerAssociation =>
  ({
    id: 'assoc-1',
    trainerProfileId: TRAINER_ID,
    playerProfileId: 'player-1',
    shareLinkId: null,
    status: AssociationStatus.Active,
    connectedAt: new Date('2024-01-01T00:00:00Z'),
    ...over,
  }) as TrainerPlayerAssociation;

const playerProfile = (over: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    id: 'player-1',
    ownerUserId: 'owner-1',
    displayName: 'Maya Chen',
    isChild: true,
    birthDate: '2012-05-01',
    gender: null,
    skillLevel: null,
    school: null,
    jerseyNumber: null,
    ...over,
  }) as PlayerProfile;

const user = (over: Partial<User> = {}): User =>
  ({
    id: 'owner-1',
    email: 'parent@example.com',
    firstName: 'Jamie',
    lastName: 'Chen',
    phone: '+1 555 000 1111',
    ...over,
  }) as User;

const rosterEntryView = (over: Partial<RosterEntryView> = {}): RosterEntryView =>
  ({
    playerProfileId: 'player-1',
    displayName: 'Maya Chen',
    isChild: true,
    birthDate: null,
    gender: null,
    skillLevel: null,
    school: null,
    jerseyNumber: null,
    accountUserId: 'owner-1',
    accountEmail: null,
    accountName: null,
    accountPhone: null,
    status: AssociationStatus.Active,
    connectedAt: new Date('2024-01-01T00:00:00Z'),
    ...over,
  }) as RosterEntryView;

interface Stub {
  service: RosterService;
  usersFindByIds: jest.Mock;
  playersFindByIds: jest.Mock;
  playersFindById: jest.Mock;
  playersSetSkillLevel: jest.Mock;
  requireOwnProfile: jest.Mock;
  associationsFindByTrainer: jest.Mock;
  associationsFind: jest.Mock;
  associationsSetStatus: jest.Mock;
  auditRecord: jest.Mock;
  clearForAssociation: jest.Mock;
}

function build(): Stub {
  const usersFindByIds = jest.fn().mockResolvedValue([]);
  const playersFindByIds = jest.fn().mockResolvedValue([]);
  const playersFindById = jest.fn();
  const playersSetSkillLevel = jest.fn();
  const requireOwnProfile = jest.fn().mockResolvedValue(trainerProfile());
  const associationsFindByTrainer = jest.fn().mockResolvedValue([]);
  const associationsFind = jest.fn();
  const associationsSetStatus = jest.fn();
  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const clearForAssociation = jest.fn().mockResolvedValue(undefined);

  const service = new RosterService(
    { findByIds: usersFindByIds } as unknown as UsersService,
    {
      findByIds: playersFindByIds,
      findById: playersFindById,
      setSkillLevel: playersSetSkillLevel,
    } as unknown as PlayersService,
    { requireOwnProfile } as unknown as TrainersService,
    {
      findByTrainer: associationsFindByTrainer,
      find: associationsFind,
      setStatus: associationsSetStatus,
    } as unknown as AssociationsService,
    { record: auditRecord } as unknown as AuditService,
    { clearForAssociation } as unknown as ContextService,
  );

  return {
    service,
    usersFindByIds,
    playersFindByIds,
    playersFindById,
    playersSetSkillLevel,
    requireOwnProfile,
    associationsFindByTrainer,
    associationsFind,
    associationsSetStatus,
    auditRecord,
    clearForAssociation,
  };
}

describe('RosterService.list', () => {
  it('requires the caller’s own trainer profile before touching associations', async () => {
    const order: string[] = [];
    const { service, requireOwnProfile, associationsFindByTrainer } = build();
    requireOwnProfile.mockImplementation(async () => {
      order.push('requireOwnProfile');
      return trainerProfile();
    });
    associationsFindByTrainer.mockImplementation(async () => {
      order.push('findByTrainer');
      return [];
    });

    await service.list(principal({ userId: 'user-9' }));

    expect(requireOwnProfile).toHaveBeenCalledWith('user-9');
    expect(order).toEqual(['requireOwnProfile', 'findByTrainer']);
  });

  it('defaults to Active associations only, dropping Inactive ones', async () => {
    const { service, associationsFindByTrainer, playersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([
      association({ playerProfileId: 'player-1', status: AssociationStatus.Active }),
      association({
        id: 'assoc-2',
        playerProfileId: 'player-2',
        status: AssociationStatus.Inactive,
      }),
    ]);
    playersFindByIds.mockResolvedValue([playerProfile({ id: 'player-1' })]);

    const rows = await service.list(principal());

    expect(rows.map((r) => r.playerProfileId)).toEqual(['player-1']);
    expect(playersFindByIds).toHaveBeenCalledWith(['player-1']);
  });

  it('includes Inactive associations when includeInactive is true', async () => {
    const { service, associationsFindByTrainer, playersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([
      association({ playerProfileId: 'player-1', status: AssociationStatus.Active }),
      association({
        id: 'assoc-2',
        playerProfileId: 'player-2',
        status: AssociationStatus.Inactive,
      }),
    ]);
    playersFindByIds.mockResolvedValue([
      playerProfile({ id: 'player-1' }),
      playerProfile({ id: 'player-2', ownerUserId: 'owner-2' }),
    ]);

    const rows = await service.list(principal(), { includeInactive: true });

    expect(rows.map((r) => r.playerProfileId).sort()).toEqual(['player-1', 'player-2']);
  });

  it('returns an empty roster without calling playersService.findByIds when nothing is Active', async () => {
    const { service, associationsFindByTrainer, playersFindByIds, usersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([
      association({ status: AssociationStatus.Inactive }),
    ]);

    const rows = await service.list(principal());

    expect(rows).toEqual([]);
    expect(playersFindByIds).not.toHaveBeenCalled();
    expect(usersFindByIds).not.toHaveBeenCalled();
  });

  it('silently drops an association whose player profile no longer exists', async () => {
    const { service, associationsFindByTrainer, playersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([
      association({ playerProfileId: 'player-1' }),
      association({ id: 'assoc-2', playerProfileId: 'player-missing' }),
    ]);
    // findByIds was asked for both ids but only returns the one that still exists.
    playersFindByIds.mockResolvedValue([playerProfile({ id: 'player-1' })]);

    const rows = await service.list(principal());

    expect(rows).toHaveLength(1);
    expect(rows[0].playerProfileId).toBe('player-1');
  });

  it('maps profile, account, and association fields onto each roster entry', async () => {
    const { service, associationsFindByTrainer, playersFindByIds, usersFindByIds } = build();
    const connectedAt = new Date('2024-03-01T00:00:00Z');
    associationsFindByTrainer.mockResolvedValue([
      association({ playerProfileId: 'player-1', status: AssociationStatus.Active, connectedAt }),
    ]);
    playersFindByIds.mockResolvedValue([
      playerProfile({
        id: 'player-1',
        ownerUserId: 'owner-1',
        displayName: 'Maya Chen',
        isChild: true,
        birthDate: '2012-05-01',
        gender: 'female',
        skillLevel: 'Intermediate',
        school: 'Riverside',
        jerseyNumber: '7',
      }),
    ]);
    usersFindByIds.mockResolvedValue([
      user({
        id: 'owner-1',
        email: 'parent@example.com',
        firstName: 'Jamie',
        lastName: 'Chen',
        phone: '+1 555 0000',
      }),
    ]);

    const [entry] = await service.list(principal());

    expect(entry).toEqual({
      playerProfileId: 'player-1',
      displayName: 'Maya Chen',
      isChild: true,
      birthDate: '2012-05-01',
      gender: 'female',
      skillLevel: 'Intermediate',
      school: 'Riverside',
      jerseyNumber: '7',
      accountUserId: 'owner-1',
      accountEmail: 'parent@example.com',
      accountName: 'Jamie Chen',
      accountPhone: '+1 555 0000',
      status: AssociationStatus.Active,
      connectedAt,
    });
  });

  it('matches search case-insensitively across display name, account email, and account name', async () => {
    const { service, associationsFindByTrainer, playersFindByIds, usersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([
      association({ playerProfileId: 'player-1' }),
      association({ id: 'assoc-2', playerProfileId: 'player-2' }),
    ]);
    playersFindByIds.mockResolvedValue([
      playerProfile({ id: 'player-1', displayName: 'Maya Chen', ownerUserId: 'owner-1' }),
      playerProfile({ id: 'player-2', displayName: 'Sam Diaz', ownerUserId: 'owner-2' }),
    ]);
    usersFindByIds.mockResolvedValue([
      user({
        id: 'owner-1',
        email: 'MAYA.PARENT@Example.com',
        firstName: 'Jamie',
        lastName: 'Chen',
      }),
      user({
        id: 'owner-2',
        email: 'sam.parent@example.com',
        firstName: 'Robin',
        lastName: 'Diaz',
      }),
    ]);

    const rows = await service.list(principal(), { search: 'maya.parent' });

    expect(rows.map((r) => r.playerProfileId)).toEqual(['player-1']);
  });

  it('does not throw when searching a profile whose linked account is missing', async () => {
    const { service, associationsFindByTrainer, playersFindByIds, usersFindByIds } = build();
    associationsFindByTrainer.mockResolvedValue([association({ playerProfileId: 'player-1' })]);
    playersFindByIds.mockResolvedValue([
      playerProfile({ id: 'player-1', displayName: 'Maya Chen', ownerUserId: 'owner-missing' }),
    ]);
    // The owner id has no matching row, so accountEmail/accountName are null.
    usersFindByIds.mockResolvedValue([]);

    const rows = await service.list(principal(), { search: 'maya' });

    expect(rows).toHaveLength(1);
    expect(rows[0].accountEmail).toBeNull();
    expect(rows[0].accountName).toBeNull();
  });
});

describe('RosterService.setSkillLevel', () => {
  it('throws NOT_FOUND when there is no association for this trainer and profile', async () => {
    const { service, associationsFind, playersFindById } = build();
    associationsFind.mockResolvedValue(null);
    playersFindById.mockResolvedValue(playerProfile());

    await expect(
      service.setSkillLevel(principal(), 'player-1', 'Intermediate'),
    ).rejects.toMatchObject(NOT_ON_ROSTER);
  });

  it('throws NOT_FOUND when the association is Inactive', async () => {
    const { service, associationsFind, playersFindById } = build();
    associationsFind.mockResolvedValue(association({ status: AssociationStatus.Inactive }));
    playersFindById.mockResolvedValue(playerProfile());

    await expect(
      service.setSkillLevel(principal(), 'player-1', 'Intermediate'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes the skill level, audits it, and returns the refreshed entry from a fresh list()', async () => {
    const { service, associationsFind, playersFindById, playersSetSkillLevel, auditRecord } =
      build();
    associationsFind.mockResolvedValue(association());
    playersFindById.mockResolvedValue(playerProfile({ id: 'player-1' }));
    const refreshed = rosterEntryView({ playerProfileId: 'player-1', skillLevel: 'Intermediate' });
    const otherEntry = rosterEntryView({ playerProfileId: 'player-2' });
    const list = jest.spyOn(service, 'list').mockResolvedValue([otherEntry, refreshed]);
    const p = principal();

    const result = await service.setSkillLevel(p, 'player-1', 'Intermediate');

    expect(playersSetSkillLevel).toHaveBeenCalledWith('player-1', 'Intermediate');
    expect(auditRecord).toHaveBeenCalledWith({
      action: AUDIT_ROSTER_SKILL_LEVEL_SET,
      actor: p,
      target: { type: 'PlayerProfile', id: 'player-1' },
      metadata: { trainerProfileId: TRAINER_ID, skillLevel: 'Intermediate' },
    });
    expect(list).toHaveBeenCalledWith(p);
    expect(result).toBe(refreshed);
  });

  it('throws NOT_FOUND if a fresh list() no longer contains the just-updated profile', async () => {
    const { service, associationsFind, playersFindById } = build();
    associationsFind.mockResolvedValue(association());
    playersFindById.mockResolvedValue(playerProfile({ id: 'player-1' }));
    jest.spyOn(service, 'list').mockResolvedValue([]);

    await expect(
      service.setSkillLevel(principal(), 'player-1', 'Intermediate'),
    ).rejects.toMatchObject(NOT_ON_ROSTER);
  });
});

describe('RosterService.remove', () => {
  it('throws NOT_FOUND when the player profile no longer exists', async () => {
    const { service, associationsFind, playersFindById } = build();
    associationsFind.mockResolvedValue(association());
    playersFindById.mockResolvedValue(null);

    await expect(service.remove(principal(), 'player-1')).rejects.toMatchObject(NOT_ON_ROSTER);
  });

  it('deactivates the association, clears any parked context, and audits the removal', async () => {
    const {
      service,
      associationsFind,
      playersFindById,
      associationsSetStatus,
      clearForAssociation,
      auditRecord,
    } = build();
    associationsFind.mockResolvedValue(association());
    playersFindById.mockResolvedValue(playerProfile({ id: 'player-1' }));
    const p = principal();

    await service.remove(p, 'player-1');

    expect(associationsSetStatus).toHaveBeenCalledWith(
      TRAINER_ID,
      'player-1',
      AssociationStatus.Inactive,
    );
    expect(clearForAssociation).toHaveBeenCalledWith('player-1', TRAINER_ID);
    expect(auditRecord).toHaveBeenCalledWith({
      action: AUDIT_ROSTER_MEMBER_REMOVED,
      actor: p,
      target: { type: 'PlayerProfile', id: 'player-1' },
      metadata: { trainerProfileId: TRAINER_ID },
    });
  });

  it('clears the parked context only after the association is deactivated', async () => {
    const order: string[] = [];
    const {
      service,
      associationsFind,
      playersFindById,
      associationsSetStatus,
      clearForAssociation,
    } = build();
    associationsFind.mockResolvedValue(association());
    playersFindById.mockResolvedValue(playerProfile({ id: 'player-1' }));
    associationsSetStatus.mockImplementation(async () => {
      order.push('setStatus');
      return association({ status: AssociationStatus.Inactive });
    });
    clearForAssociation.mockImplementation(async () => {
      order.push('clearForAssociation');
    });

    await service.remove(principal(), 'player-1');

    expect(order).toEqual(['setStatus', 'clearForAssociation']);
  });
});
