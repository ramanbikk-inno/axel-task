import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile, CoachStatus } from '../coaches/entities/coach-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { CoachLookupService } from './coach-lookup.service';

/**
 * This service is the tenancy boundary for every trainer-facing coach
 * endpoint, so the queries themselves are asserted here rather than mocked.
 * Both consumers stub it out, which is exactly why it needs its own spec: a
 * dropped `trainerProfileId` predicate would be a cross-org read and no other
 * unit test would notice.
 */
const makeService = (
  row: CoachProfile | null = null,
  trainer: { id: string } | null = { id: 't1' },
): { service: CoachLookupService; findOne: jest.Mock; findByUserId: jest.Mock } => {
  const findOne = jest.fn().mockResolvedValue(row);
  const findByUserId = jest.fn().mockResolvedValue(trainer);
  return {
    service: new CoachLookupService(
      { findOne } as unknown as Repository<CoachProfile>,
      { findByUserId } as unknown as TrainersService,
    ),
    findOne,
    findByUserId,
  };
};

const COACH = { id: 'c1', userId: 'coach-user', trainerProfileId: 't1' } as CoachProfile;

describe('CoachLookupService', () => {
  describe('requireOwnProfile', () => {
    it('looks the profile up by the caller own user id, never by profile id', async () => {
      const { service, findOne } = makeService(COACH);

      await service.requireOwnProfile('coach-user');

      // Keying on anything the caller supplies would be an IDOR: one coach
      // could read another's profile by guessing an id.
      expect(findOne).toHaveBeenCalledWith({
        where: { userId: 'coach-user', status: CoachStatus.Active },
      });
    });

    /**
     * Off-boarding keeps the row and the unique index is partial, so a coach
     * who was let go and re-hired has two. Without the status predicate,
     * findOne picked between them arbitrarily and My Times writes could land on
     * the ended engagement — the coach saw a saved schedule while the trainer's
     * conflict check, which resolves the coach through the org-scoped id, read
     * an empty one.
     */
    it('resolves the active engagement for a re-hired coach, not the ended one', async () => {
      const { service, findOne } = makeService(null);
      const ended = { id: 'c-old', userId: 'coach-user', status: CoachStatus.Inactive };
      const active = { id: 'c-new', userId: 'coach-user', status: CoachStatus.Active };
      findOne.mockImplementation(async (opts: { where: { status?: CoachStatus } }) =>
        [ended, active].find((r) => r.status === opts.where.status),
      );

      await expect(service.requireOwnProfile('coach-user')).resolves.toMatchObject({
        id: 'c-new',
      });
    });

    it('refuses an off-boarded coach: their tenancy ended with the row', async () => {
      const { service, findOne } = makeService(null);
      // Only the Inactive row exists, so the Active-scoped query matches nothing.
      findOne.mockResolvedValue(null);

      await expect(service.requireOwnProfile('coach-user')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(findOne).toHaveBeenCalledWith({
        where: { userId: 'coach-user', status: CoachStatus.Active },
      });
    });

    it('throws 403 COACH_PROFILE_NOT_FOUND when the account is not a coach', async () => {
      const { service } = makeService(null);

      try {
        await service.requireOwnProfile('nobody');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
        });
      }
    });
  });

  describe('requireInOwnOrg', () => {
    it('pins both the coach id and the calling trainer org in one query', async () => {
      const { service, findOne } = makeService(COACH);

      await service.requireInOwnOrg('trainer-user', 'c1');

      // Dropping trainerProfileId here would let any trainer read any coach.
      expect(findOne).toHaveBeenCalledWith({
        where: { id: 'c1', trainerProfileId: 't1', status: CoachStatus.Active },
      });
    });

    it('hides an off-boarded coach from their former employer', async () => {
      // The ended row still carries the old trainerProfileId, so without the
      // status predicate the previous employer keeps a live read on someone who
      // no longer works for them.
      const { service, findOne } = makeService(null);

      await expect(service.requireInOwnOrg('trainer-user', 'c-old')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(findOne).toHaveBeenCalledWith({
        where: { id: 'c-old', trainerProfileId: 't1', status: CoachStatus.Active },
      });
    });

    it('reports a foreign-org coach as 404, not 403, so ids cannot be probed', async () => {
      const { service } = makeService(null);

      try {
        await service.requireInOwnOrg('trainer-user', 'other-org-coach');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          errorCode: ErrorCode.NOT_FOUND,
        });
      }
    });

    it('refuses before querying when the caller has no trainer profile', async () => {
      const { service, findOne } = makeService(COACH, null);

      await expect(service.requireInOwnOrg('nobody', 'c1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  describe('requireTrainer', () => {
    it('returns the trainer profile id for a real trainer', async () => {
      const { service } = makeService(null, { id: 't9' });

      await expect(service.requireTrainer('trainer-user')).resolves.toEqual({ id: 't9' });
    });

    it('throws 403 TRAINER_PROFILE_NOT_FOUND otherwise', async () => {
      const { service } = makeService(null, null);

      try {
        await service.requireTrainer('nobody');
        fail('expected throw');
      } catch (err) {
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        });
      }
    });
  });
});
