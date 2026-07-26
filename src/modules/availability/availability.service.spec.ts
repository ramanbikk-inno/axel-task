import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { AvailabilityService } from './availability.service';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AssociationsService } from '../enrollment/associations.service';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../enrollment/entities/trainer-player-association.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { CoachLookupService } from './coach-lookup.service';
import { UsersService } from '../users/users.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AvailabilitySlotInput } from './dto/availability.dto';

/**
 * These tests exercise ownership and window maths, not authorization, so the
 * principal only has to carry a user id — the service reads nothing else off it
 * beyond handing it to the audit trail.
 */
const principal = (userId: string): Principal =>
  ({
    userId,
    role: Role.PlayerParent,
    sessionId: 'session-1',
    impersonating: false,
  }) as Principal;

const slotRow = (
  playerProfileId: string,
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
  isAvailable = true,
): AvailabilitySlot =>
  ({
    playerProfileId,
    coachProfileId: null,
    dayOfWeek,
    startMinute,
    endMinute,
    isAvailable,
  }) as AvailabilitySlot;

const coachSlotRow = (
  coachProfileId: string,
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
  isAvailable = true,
): AvailabilitySlot =>
  ({
    playerProfileId: null,
    coachProfileId,
    dayOfWeek,
    startMinute,
    endMinute,
    isAvailable,
  }) as AvailabilitySlot;

const profile = (id: string, displayName: string, ownerUserId = 'owner'): PlayerProfile =>
  ({ id, displayName, ownerUserId }) as PlayerProfile;

const assoc = (
  playerProfileId: string,
  status: AssociationStatus = AssociationStatus.Active,
): TrainerPlayerAssociation => ({ playerProfileId, status }) as TrainerPlayerAssociation;

const input = (dayOfWeek: number, startTime: string, endTime: string): AvailabilitySlotInput => ({
  dayOfWeek,
  startTime,
  endTime,
});

const makeService = (): {
  service: AvailabilityService;
  slotsFind: jest.Mock;
  txDelete: jest.Mock;
  txSave: jest.Mock;
  txCreate: jest.Mock;
  findById: jest.Mock;
  findByIds: jest.Mock;
  findByUserId: jest.Mock;
  findByTrainer: jest.Mock;
  coachFindOne: jest.Mock;
  userFindById: jest.Mock;
  lockFindOne: jest.Mock;
} => {
  const slotsFind = jest.fn().mockResolvedValue([]);
  const txDelete = jest.fn().mockResolvedValue(undefined);
  const txSave = jest.fn().mockResolvedValue(undefined);
  const txCreate = jest.fn((entity: unknown) => entity);
  const findById = jest.fn();
  const findByIds = jest.fn().mockResolvedValue([]);
  const findByUserId = jest.fn();
  const findByTrainer = jest.fn().mockResolvedValue([]);
  const coachFindOne = jest.fn().mockResolvedValue(null);
  const userFindById = jest.fn().mockResolvedValue(null);

  const slots = { find: slotsFind } as unknown as Repository<AvailabilitySlot>;
  const coachLookup = {
    requireOwnProfile: jest.fn(async (userId: string) => {
      const row = await coachFindOne({ where: { userId } });
      if (!row) {
        throw new ForbiddenException({ errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND });
      }
      return row;
    }),
    requireInOwnOrg: jest.fn(async (_trainerUserId: string, coachProfileId: string) => {
      await findByUserId();
      const row = await coachFindOne({ where: { id: coachProfileId } });
      if (!row) {
        throw new NotFoundException({ errorCode: ErrorCode.NOT_FOUND });
      }
      return row;
    }),
    requireTrainer: jest.fn(async (userId: string) => {
      const row = await findByUserId(userId);
      if (!row) {
        throw new ForbiddenException({ errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND });
      }
      return row;
    }),
  } as unknown as CoachLookupService;
  // find() too: the replace now reads its result back inside the transaction.
  const txRepo = { delete: txDelete, save: txSave, create: txCreate, find: slotsFind };
  const lockFindOne = jest.fn().mockResolvedValue({ id: 'owner' });
  const dataSource = {
    transaction: async <T>(cb: (mgr: EntityManager) => Promise<T>): Promise<T> =>
      cb({
        getRepository: (target: unknown) =>
          target === AvailabilitySlot ? txRepo : { findOne: lockFindOne },
      } as unknown as EntityManager),
  } as unknown as DataSource;
  const playersService = { findById, findByIds } as unknown as PlayersService;
  const associations = { findByTrainer } as unknown as AssociationsService;

  const usersService = { findById: userFindById } as unknown as UsersService;

  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord } as unknown as AuditService;

  const service = new AvailabilityService(
    slots,
    dataSource,
    playersService,
    usersService,
    coachLookup,
    associations,
    audit,
  );

  return {
    service,
    slotsFind,
    txDelete,
    txSave,
    txCreate,
    findById,
    findByIds,
    findByUserId,
    findByTrainer,
    coachFindOne,
    userFindById,
    lockFindOne,
  };
};

describe('AvailabilityService', () => {
  describe('setForProfile — ownership', () => {
    it('throws NotFound (NOT_FOUND) when the profile does not exist', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(null);

      try {
        await service.setForProfile(principal('owner'), 'missing', [input(1, '17:00', '20:00')]);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          errorCode: ErrorCode.NOT_FOUND,
        });
      }
    });

    it('throws Forbidden (PROFILE_NOT_OWNED) when the caller does not own the profile', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid', 'someone-else'));

      try {
        await service.setForProfile(principal('owner'), 'p1', [input(1, '17:00', '20:00')]);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          errorCode: ErrorCode.PROFILE_NOT_OWNED,
        });
      }
    });

    it('checks ownership exactly once per write (no redundant lookup)', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await service.setForProfile(principal('owner'), 'p1', [input(1, '17:00', '20:00')]);

      expect(findById).toHaveBeenCalledTimes(1);
    });
  });

  describe('setForProfile — slot validation', () => {
    it('rejects an inverted range (endTime <= startTime)', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      try {
        await service.setForProfile(principal('owner'), 'p1', [input(1, '20:00', '17:00')]);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          errorCode: ErrorCode.VALIDATION_ERROR,
        });
      }
    });

    it('rejects an equal-boundary range (endTime === startTime)', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await expect(
        service.setForProfile(principal('owner'), 'p1', [input(1, '17:00', '17:00')]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects overlapping windows on the same day', async () => {
      const { service, findById, txSave } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      try {
        await service.setForProfile(principal('owner'), 'p1', [
          input(1, '17:00', '20:00'),
          input(1, '19:00', '21:00'),
        ]);
        fail('expected throw');
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          errorCode: ErrorCode.VALIDATION_ERROR,
        });
      }
      expect(txSave).not.toHaveBeenCalled();
    });

    it('detects overlap regardless of input ordering', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      // Later-starting window listed first: the sort-then-compare must still catch it.
      await expect(
        service.setForProfile(principal('owner'), 'p1', [
          input(1, '19:00', '21:00'),
          input(1, '17:00', '20:00'),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('detects overlap between non-adjacent items in the input list', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      // Items 0 and 2 overlap (09:00-10:00 vs 09:30-09:45); item 1 sits far away.
      await expect(
        service.setForProfile(principal('owner'), 'p1', [
          input(1, '09:00', '10:00'),
          input(1, '15:00', '16:00'),
          input(1, '09:30', '09:45'),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects exact duplicate windows (they overlap)', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await expect(
        service.setForProfile(principal('owner'), 'p1', [
          input(1, '17:00', '20:00'),
          input(1, '17:00', '20:00'),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows adjacent (touching) windows on the same day — ranges are end-exclusive', async () => {
      const { service, findById, txSave } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await service.setForProfile(principal('owner'), 'p1', [
        input(1, '17:00', '18:00'),
        input(1, '18:00', '19:00'),
      ]);

      expect(txSave).toHaveBeenCalledTimes(1);
    });

    it('allows identical times on different days', async () => {
      const { service, findById, txSave } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await service.setForProfile(principal('owner'), 'p1', [
        input(1, '17:00', '20:00'),
        input(2, '17:00', '20:00'),
      ]);

      expect(txSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('setForProfile — persistence', () => {
    it('replaces the set: deletes existing rows then saves the new ones', async () => {
      const { service, findById, txDelete, txSave, txCreate } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      await service.setForProfile(principal('owner'), 'p1', [input(1, '17:00', '20:00')]);

      expect(txDelete).toHaveBeenCalledWith({ playerProfileId: 'p1', coachProfileId: IsNull() });
      expect(txCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          playerProfileId: 'p1',
          coachProfileId: null,
          dayOfWeek: 1,
          startMinute: 1020,
          endMinute: 1200,
          isAvailable: true,
        }),
      );
      expect(txSave).toHaveBeenCalledWith([
        expect.objectContaining({ startMinute: 1020, endMinute: 1200 }),
      ]);
    });

    it('clears all availability on empty input without saving', async () => {
      const { service, findById, txDelete, txSave } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));

      const result = await service.setForProfile(principal('owner'), 'p1', []);

      expect(txDelete).toHaveBeenCalledWith({ playerProfileId: 'p1', coachProfileId: IsNull() });
      expect(txSave).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('returns the persisted view (minutes rendered back to HH:MM)', async () => {
      const { service, findById, slotsFind } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));
      slotsFind.mockResolvedValue([slotRow('p1', 1, 1020, 1200)]);

      const result = await service.setForProfile(principal('owner'), 'p1', [
        input(1, '17:00', '20:00'),
      ]);

      expect(result).toEqual([
        { dayOfWeek: 1, startTime: '17:00', endTime: '20:00', isAvailable: true },
      ]);
    });
  });

  describe('getForProfile', () => {
    it('enforces ownership before reading', async () => {
      const { service, findById } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid', 'someone-else'));

      await expect(service.getForProfile('owner', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('maps rows to the HH:MM view', async () => {
      const { service, findById, slotsFind } = makeService();
      findById.mockResolvedValue(profile('p1', 'Kid'));
      slotsFind.mockResolvedValue([slotRow('p1', 3, 1080, 1260)]);

      const result = await service.getForProfile('owner', 'p1');

      expect(result).toEqual([
        { dayOfWeek: 3, startTime: '18:00', endTime: '21:00', isAvailable: true },
      ]);
    });
  });

  describe('trainerView', () => {
    it('throws Forbidden (TRAINER_PROFILE_NOT_FOUND) when the account has no trainer profile', async () => {
      const { service, findByUserId } = makeService();
      findByUserId.mockResolvedValue(null);

      try {
        await service.trainerView('u1', {});
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        });
      }
    });

    it('returns an empty list when the trainer has no active associations', async () => {
      const { service, findByUserId, findByTrainer } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([]);

      await expect(service.trainerView('u1', {})).resolves.toEqual([]);
    });

    it('excludes non-active associations', async () => {
      const { service, findByUserId, findByTrainer, findByIds } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1', AssociationStatus.Inactive)]);

      const result = await service.trainerView('u1', {});

      expect(result).toEqual([]);
      expect(findByIds).not.toHaveBeenCalled();
    });

    it('dedupes profile ids drawn from multiple associations', async () => {
      const { service, findByUserId, findByTrainer, findByIds } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1'), assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);

      await service.trainerView('u1', {});

      expect(findByIds).toHaveBeenCalledWith(['p1']);
    });

    it('returns every associated player with their full slot list when unfiltered', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([slotRow('p1', 1, 1020, 1200), slotRow('p1', 3, 1080, 1260)]);

      const result = await service.trainerView('u1', {});

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ playerProfileId: 'p1', displayName: 'Amy' });
      expect(result[0].slots).toHaveLength(2);
    });

    it('filters by dayOfWeek', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1'), assoc('p2')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy'), profile('p2', 'Bob')]);
      slotsFind.mockResolvedValue([slotRow('p1', 1, 1020, 1200), slotRow('p2', 2, 1020, 1200)]);

      const result = await service.trainerView('u1', { dayOfWeek: 1 });

      expect(result.map((v) => v.playerProfileId)).toEqual(['p1']);
    });

    it('filters by time with an end-exclusive window', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([slotRow('p1', 1, 1020, 1200)]); // 17:00–20:00

      await expect(service.trainerView('u1', { time: '17:00' })).resolves.toHaveLength(1); // start inclusive
      await expect(service.trainerView('u1', { time: '20:00' })).resolves.toHaveLength(0); // end exclusive
    });

    it('matches a Sunday (dayOfWeek 0) filter — the falsy-zero guard holds', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([slotRow('p1', 0, 540, 660)]); // Sun 09:00–11:00

      const result = await service.trainerView('u1', { dayOfWeek: 0, time: '10:00' });

      expect(result).toHaveLength(1);
    });

    it('handles a midnight (00:00) time filter as a real value, not "no filter"', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([slotRow('p1', 1, 1020, 1200)]); // 17:00–20:00, not covering 00:00

      await expect(service.trainerView('u1', { time: '00:00' })).resolves.toEqual([]);
    });

    it('returns players in a stable order sorted by displayName', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1'), assoc('p2')]);
      // Deliberately returned out of order.
      findByIds.mockResolvedValue([profile('p2', 'Zed'), profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([]);

      const result = await service.trainerView('u1', {});

      expect(result.map((v) => v.displayName)).toEqual(['Amy', 'Zed']);
    });

    it('breaks displayName ties deterministically by profile id', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1'), assoc('p2')]);
      // Same displayName, returned out of id order (mimics unordered DB rows).
      findByIds.mockResolvedValue([profile('p2', 'John Smith'), profile('p1', 'John Smith')]);
      slotsFind.mockResolvedValue([]);

      const result = await service.trainerView('u1', {});

      expect(result.map((v) => v.playerProfileId)).toEqual(['p1', 'p2']);
    });

    it('keeps a matched player’s full slot list even when a filter is applied', async () => {
      const { service, findByUserId, findByTrainer, findByIds, slotsFind } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      findByTrainer.mockResolvedValue([assoc('p1')]);
      findByIds.mockResolvedValue([profile('p1', 'Amy')]);
      slotsFind.mockResolvedValue([
        slotRow('p1', 1, 1020, 1200), // Mon 17:00–20:00 (matches)
        slotRow('p1', 3, 1080, 1260), // Wed 18:00–21:00 (does not match the Monday filter)
      ]);

      const result = await service.trainerView('u1', { dayOfWeek: 1 });

      expect(result).toHaveLength(1);
      expect(result[0].slots).toHaveLength(2);
    });
  });
  describe('coach My Times', () => {
    const coachRow = { id: 'c1', userId: 'coach-user', trainerProfileId: 't1' };

    it('throws Forbidden (COACH_PROFILE_NOT_FOUND) when the account is not a coach', async () => {
      const { service, coachFindOne } = makeService();
      coachFindOne.mockResolvedValue(null);

      try {
        await service.setForCoach(principal('coach-user'), [input(1, '16:00', '20:00')]);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        });
      }
    });

    it('writes slots owned by the coach, never by a player', async () => {
      const { service, coachFindOne, txDelete, txCreate } = makeService();
      coachFindOne.mockResolvedValue(coachRow);

      await service.setForCoach(principal('coach-user'), [input(1, '16:00', '20:00')]);

      // Both owner columns are pinned so a coach id can never delete or read
      // rows that happen to share the value with a player id.
      expect(txDelete).toHaveBeenCalledWith({ playerProfileId: IsNull(), coachProfileId: 'c1' });
      expect(txCreate).toHaveBeenCalledWith(
        expect.objectContaining({ coachProfileId: 'c1', playerProfileId: null }),
      );
    });

    it('applies the same overlap validation players get', async () => {
      const { service, coachFindOne, txSave } = makeService();
      coachFindOne.mockResolvedValue(coachRow);

      await expect(
        service.setForCoach(principal('coach-user'), [
          input(1, '16:00', '20:00'),
          input(1, '18:00', '21:00'),
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(txSave).not.toHaveBeenCalled();
    });

    it('supports multiple windows on one day (Monday 4-6pm AND 7-9pm)', async () => {
      const { service, coachFindOne, txSave } = makeService();
      coachFindOne.mockResolvedValue(coachRow);

      await service.setForCoach(principal('coach-user'), [
        input(1, '16:00', '18:00'),
        input(1, '19:00', '21:00'),
      ]);

      expect(txSave).toHaveBeenCalledWith([
        expect.objectContaining({ startMinute: 960, endMinute: 1080 }),
        expect.objectContaining({ startMinute: 1140, endMinute: 1260 }),
      ]);
    });

    it('lets a blackout overlap an available window — that is what carves the hole', async () => {
      const { service, coachFindOne, txSave } = makeService();
      coachFindOne.mockResolvedValue(coachRow);

      await service.setForCoach(principal('coach-user'), [
        input(1, '16:00', '20:00'),
        { ...input(1, '17:00', '18:00'), isAvailable: false },
      ]);

      expect(txSave).toHaveBeenCalledTimes(1);
    });

    it('still rejects two blackouts that overlap each other', async () => {
      const { service, coachFindOne } = makeService();
      coachFindOne.mockResolvedValue(coachRow);

      await expect(
        service.setForCoach(principal('coach-user'), [
          { ...input(1, '17:00', '19:00'), isAvailable: false },
          { ...input(1, '18:00', '20:00'), isAvailable: false },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reads back only the coach own slots', async () => {
      const { service, coachFindOne, slotsFind } = makeService();
      coachFindOne.mockResolvedValue(coachRow);
      slotsFind.mockResolvedValue([coachSlotRow('c1', 1, 960, 1200)]);

      await expect(service.getForCoach('coach-user')).resolves.toEqual([
        { dayOfWeek: 1, startTime: '16:00', endTime: '20:00', isAvailable: true },
      ]);
    });
  });

  describe('checkCoachConflict (trainer assignment flow)', () => {
    const setup = (daySlots: AvailabilitySlot[]): ReturnType<typeof makeService> => {
      const ctx = makeService();
      ctx.findByUserId.mockResolvedValue({ id: 't1' });
      ctx.coachFindOne.mockResolvedValue({
        id: 'c1',
        userId: 'coach-user',
        trainerProfileId: 't1',
      });
      ctx.userFindById.mockResolvedValue({ firstName: 'Sam', lastName: 'Coach', email: 'c@x.io' });
      ctx.slotsFind.mockResolvedValue(daySlots);
      return ctx;
    };

    it('reports available when the window sits inside a stated slot', async () => {
      const { service } = setup([coachSlotRow('c1', 1, 960, 1200)]); // Mon 16:00–20:00

      const result = await service.checkCoachConflict('trainer-user', 'c1', {
        dayOfWeek: 1,
        startTime: '17:00',
        endTime: '18:00',
      });

      expect(result).toMatchObject({ available: true, message: null });
    });

    it('reports available for an exact-boundary match', async () => {
      const { service } = setup([coachSlotRow('c1', 1, 960, 1200)]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '16:00',
          endTime: '20:00',
        }),
      ).resolves.toMatchObject({ available: true });
    });

    it('reports a conflict when the window runs past the end of the slot', async () => {
      const { service } = setup([coachSlotRow('c1', 1, 960, 1200)]);

      const result = await service.checkCoachConflict('trainer-user', 'c1', {
        dayOfWeek: 1,
        startTime: '19:00',
        endTime: '21:00',
      });

      expect(result.available).toBe(false);
      expect(result.message).toBe(
        'Coach Sam Coach is not available at this time per their schedule. Continue anyway?',
      );
    });

    it('reports a conflict when the coach has stated nothing for that day', async () => {
      const { service } = setup([]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 4,
          startTime: '10:00',
          endTime: '11:00',
        }),
      ).resolves.toMatchObject({ available: false });
    });

    it('treats touching windows as one continuous block', async () => {
      // 16:00–18:00 + 18:00–20:00 must cover a 17:00–19:00 request.
      const { service } = setup([
        coachSlotRow('c1', 1, 960, 1080),
        coachSlotRow('c1', 1, 1080, 1200),
      ]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '17:00',
          endTime: '19:00',
        }),
      ).resolves.toMatchObject({ available: true });
    });

    it('does not bridge a gap between two separate windows', async () => {
      // 16:00–17:00 and 19:00–20:00 leave 17:00–19:00 uncovered.
      const { service } = setup([
        coachSlotRow('c1', 1, 960, 1020),
        coachSlotRow('c1', 1, 1140, 1200),
      ]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '16:30',
          endTime: '19:30',
        }),
      ).resolves.toMatchObject({ available: false });
    });

    it('lets a blackout override an otherwise-covering window', async () => {
      const { service } = setup([
        coachSlotRow('c1', 1, 960, 1200),
        coachSlotRow('c1', 1, 1020, 1080, false), // 17:00–18:00 blocked
      ]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '17:30',
          endTime: '17:45',
        }),
      ).resolves.toMatchObject({ available: false });
    });

    it('a blackout that only touches the edge is not a conflict', async () => {
      const { service } = setup([
        coachSlotRow('c1', 1, 960, 1200),
        coachSlotRow('c1', 1, 1080, 1140, false), // 18:00–19:00 blocked
      ]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '17:00',
          endTime: '18:00',
        }),
      ).resolves.toMatchObject({ available: true });
    });

    it('refuses a coach from another organisation as not found', async () => {
      const { service, findByUserId, coachFindOne } = makeService();
      findByUserId.mockResolvedValue({ id: 't1' });
      // The id+trainerProfileId query returns nothing for a foreign coach.
      coachFindOne.mockResolvedValue(null);

      await expect(
        service.checkCoachConflict('trainer-user', 'other-org-coach', {
          dayOfWeek: 1,
          startTime: '16:00',
          endTime: '17:00',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an inverted window before touching the database', async () => {
      const { service } = setup([]);

      await expect(
        service.checkCoachConflict('trainer-user', 'c1', {
          dayOfWeek: 1,
          startTime: '18:00',
          endTime: '16:00',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falls back to the email when the coach has no name set', async () => {
      const ctx = setup([]);
      ctx.userFindById.mockResolvedValue({ firstName: null, lastName: null, email: 'c@x.io' });

      const result = await ctx.service.checkCoachConflict('trainer-user', 'c1', {
        dayOfWeek: 1,
        startTime: '10:00',
        endTime: '11:00',
      });

      expect(result.message).toContain('c@x.io');
    });
  });
});
