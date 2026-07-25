import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { CoachLookupService } from './coach-lookup.service';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { AvailabilityService } from './availability.service';
import { CoachOverridesService } from './coach-overrides.service';
import { CoachAvailabilityOverride } from './entities/coach-availability-override.entity';

const COACH = { id: 'c1', userId: 'coach-user', trainerProfileId: 't1' } as CoachProfile;

const makeService = (): {
  service: CoachOverridesService;
  save: jest.Mock;
  findAndCount: jest.Mock;
  requireOwnProfile: jest.Mock;
  requireInOwnOrg: jest.Mock;
  requireTrainer: jest.Mock;
  isCoachFreeFor: jest.Mock;
  sendOverrideEmail: jest.Mock;
} => {
  const save = jest.fn((row: CoachAvailabilityOverride) => Promise.resolve({ ...row, id: 'o1' }));
  const findAndCount = jest.fn().mockResolvedValue([[], 0]);
  const requireOwnProfile = jest.fn().mockResolvedValue(COACH);
  const requireInOwnOrg = jest.fn().mockResolvedValue(COACH);
  const requireTrainer = jest.fn().mockResolvedValue({ id: 't1' });
  // Default: the window clashes, which is the case an override exists for.
  const isCoachFreeFor = jest.fn().mockResolvedValue(false);
  const sendOverrideEmail = jest.fn().mockResolvedValue(undefined);

  const overrides = {
    save,
    findAndCount,
    create: (row: Partial<CoachAvailabilityOverride>) => row as CoachAvailabilityOverride,
  } as unknown as Repository<CoachAvailabilityOverride>;
  const availability = { isCoachFreeFor } as unknown as AvailabilityService;
  const coachLookup = {
    requireOwnProfile,
    requireInOwnOrg,
    requireTrainer,
  } as unknown as CoachLookupService;
  const trainersService = {
    findById: jest.fn().mockResolvedValue({ id: 't1', businessName: 'Elite Soccer' }),
  } as unknown as TrainersService;
  const usersService = {
    findById: jest.fn().mockResolvedValue({ id: 'coach-user', email: 'coach@example.com' }),
  } as unknown as UsersService;
  const mail = {
    sendCoachAvailabilityOverrideEmail: sendOverrideEmail,
  } as unknown as MailService;

  return {
    service: new CoachOverridesService(
      overrides,
      availability,
      coachLookup,
      trainersService,
      usersService,
      mail,
    ),
    save,
    findAndCount,
    requireOwnProfile,
    requireInOwnOrg,
    requireTrainer,
    isCoachFreeFor,
    sendOverrideEmail,
  };
};

const PAGE = { page: 1, limit: 20 };

const dto = {
  coachProfileId: 'c1',
  dayOfWeek: 1,
  startTime: '16:00',
  endTime: '18:00',
  overrideReason: 'Only coach certified for this age group.',
};

describe('CoachOverridesService (US-01.10)', () => {
  it('records the override against the coach and the acting trainer', async () => {
    const { service, save } = makeService();

    const result = await service.record('trainer-user', dto);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        coachProfileId: 'c1',
        trainerProfileId: 't1',
        dayOfWeek: 1,
        startMinute: 960,
        endMinute: 1080,
        overrideReason: 'Only coach certified for this age group.',
        overriddenByUserId: 'trainer-user',
        eventId: null,
      }),
    );
    expect(result).toMatchObject({ startTime: '16:00', endTime: '18:00' });
  });

  it('stores the event id when the caller has one (Epic-02 seam)', async () => {
    const { service, save } = makeService();

    await service.record('trainer-user', { ...dto, eventId: 'e-9' });

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e-9' }));
  });

  it('goes through the tenancy gate before writing', async () => {
    const { service, requireInOwnOrg } = makeService();

    await service.record('trainer-user', dto);

    expect(requireInOwnOrg).toHaveBeenCalledWith('trainer-user', 'c1');
  });

  it('never writes an override for a coach outside the caller org', async () => {
    const { service, requireInOwnOrg, save } = makeService();
    requireInOwnOrg.mockRejectedValue(new ForbiddenException());

    await expect(service.record('trainer-user', dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an inverted window', async () => {
    const { service, save } = makeService();

    await expect(
      service.record('trainer-user', { ...dto, startTime: '18:00', endTime: '16:00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('notifies the coach (Q-01.06)', async () => {
    const { service, sendOverrideEmail } = makeService();

    await service.record('trainer-user', dto);

    expect(sendOverrideEmail).toHaveBeenCalledWith('coach@example.com', {
      trainerName: 'Elite Soccer',
      dayName: 'Monday',
      startTime: '16:00',
      endTime: '18:00',
      reason: 'Only coach certified for this age group.',
    });
  });

  it('still returns the recorded override when the notification fails', async () => {
    const { service, sendOverrideEmail } = makeService();
    sendOverrideEmail.mockRejectedValue(new Error('provider down'));

    // The row is already committed; surfacing a 500 here would invite a retry
    // that appends a second override for the same assignment.
    await expect(service.record('trainer-user', dto)).resolves.toMatchObject({ id: 'o1' });
  });

  it('lists a trainer own organisation overrides', async () => {
    const { service, findAndCount } = makeService();

    await service.listForTrainer('trainer-user', PAGE);

    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trainerProfileId: 't1' }, skip: 0, take: 20 }),
    );
  });

  it('refuses to list for an account with no trainer profile', async () => {
    const { service, requireTrainer } = makeService();
    requireTrainer.mockRejectedValue(
      new ForbiddenException({ errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND }),
    );

    try {
      await service.listForTrainer('nobody', PAGE);
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
      });
    }
  });

  it('lets a coach read the overrides filed against them', async () => {
    const { service, findAndCount } = makeService();

    await service.listForCoach('coach-user', PAGE);

    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { coachProfileId: 'c1' }, skip: 0, take: 20 }),
    );
  });

  it('refuses to list for an account with no coach profile', async () => {
    const { service, requireOwnProfile } = makeService();
    requireOwnProfile.mockRejectedValue(
      new ForbiddenException({ errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND }),
    );

    try {
      await service.listForCoach('nobody', PAGE);
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
      });
    }
  });
  it('records that the window actually conflicted', async () => {
    const { service, save, isCoachFreeFor } = makeService();
    isCoachFreeFor.mockResolvedValue(false);

    const result = await service.record('trainer-user', dto);

    expect(isCoachFreeFor).toHaveBeenCalledWith('c1', 1, 960, 1080);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ hadConflict: true }));
    expect(result.hadConflict).toBe(true);
  });

  it('marks a no-op override rather than silently logging it as a real one', async () => {
    // The coach was free the whole time: a client racing stale availability.
    const { service, save, isCoachFreeFor } = makeService();
    isCoachFreeFor.mockResolvedValue(true);

    const result = await service.record('trainer-user', dto);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ hadConflict: false }));
    expect(result.hadConflict).toBe(false);
  });

  it('does not email the coach when nothing was actually overridden', async () => {
    const { service, sendOverrideEmail, isCoachFreeFor } = makeService();
    isCoachFreeFor.mockResolvedValue(true);

    await service.record('trainer-user', dto);

    expect(sendOverrideEmail).not.toHaveBeenCalled();
  });

  it('offsets by page for the trainer trail', async () => {
    const { service, findAndCount } = makeService();

    await service.listForTrainer('trainer-user', { page: 3, limit: 10 });

    expect(findAndCount).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('returns the platform-wide trail unscoped for a Super Admin', async () => {
    const { service, findAndCount, requireTrainer } = makeService();
    findAndCount.mockResolvedValue([[], 7]);

    const result = await service.listAll(PAGE);

    expect(requireTrainer).not.toHaveBeenCalled();
    expect(findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(result).toMatchObject({ total: 7, page: 1, limit: 20 });
  });
});
