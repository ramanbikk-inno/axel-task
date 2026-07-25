import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
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
  find: jest.Mock;
  coachFindOne: jest.Mock;
  resolveCoachInOwnOrg: jest.Mock;
  findByUserId: jest.Mock;
  sendOverrideEmail: jest.Mock;
} => {
  const save = jest.fn((row: CoachAvailabilityOverride) => Promise.resolve({ ...row, id: 'o1' }));
  const find = jest.fn().mockResolvedValue([]);
  const coachFindOne = jest.fn().mockResolvedValue(null);
  const resolveCoachInOwnOrg = jest.fn().mockResolvedValue(COACH);
  const findByUserId = jest.fn().mockResolvedValue({ id: 't1' });
  const sendOverrideEmail = jest.fn().mockResolvedValue(undefined);

  const overrides = {
    save,
    find,
    create: (row: Partial<CoachAvailabilityOverride>) => row as CoachAvailabilityOverride,
  } as unknown as Repository<CoachAvailabilityOverride>;
  const coachProfiles = { findOne: coachFindOne } as unknown as Repository<CoachProfile>;
  const availability = { resolveCoachInOwnOrg } as unknown as AvailabilityService;
  const trainersService = {
    findByUserId,
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
      coachProfiles,
      availability,
      trainersService,
      usersService,
      mail,
    ),
    save,
    find,
    coachFindOne,
    resolveCoachInOwnOrg,
    findByUserId,
    sendOverrideEmail,
  };
};

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
    const { service, resolveCoachInOwnOrg } = makeService();

    await service.record('trainer-user', dto);

    expect(resolveCoachInOwnOrg).toHaveBeenCalledWith('trainer-user', 'c1');
  });

  it('never writes an override for a coach outside the caller org', async () => {
    const { service, resolveCoachInOwnOrg, save } = makeService();
    resolveCoachInOwnOrg.mockRejectedValue(new ForbiddenException());

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
    const { service, find } = makeService();

    await service.listForTrainer('trainer-user');

    expect(find).toHaveBeenCalledWith({
      where: { trainerProfileId: 't1' },
      order: { createdAt: 'DESC' },
    });
  });

  it('refuses to list for an account with no trainer profile', async () => {
    const { service, findByUserId } = makeService();
    findByUserId.mockResolvedValue(null);

    try {
      await service.listForTrainer('nobody');
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
      });
    }
  });

  it('lets a coach read the overrides filed against them', async () => {
    const { service, find, coachFindOne } = makeService();
    coachFindOne.mockResolvedValue(COACH);

    await service.listForCoach('coach-user');

    expect(find).toHaveBeenCalledWith({
      where: { coachProfileId: 'c1' },
      order: { createdAt: 'DESC' },
    });
  });

  it('refuses to list for an account with no coach profile', async () => {
    const { service, coachFindOne } = makeService();
    coachFindOne.mockResolvedValue(null);

    try {
      await service.listForCoach('nobody');
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND,
      });
    }
  });
});
