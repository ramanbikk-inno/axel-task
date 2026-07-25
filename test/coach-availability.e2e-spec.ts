import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { AvailabilitySlot } from '../src/modules/availability/entities/availability-slot.entity';
import { CoachAvailabilityOverride } from '../src/modules/availability/entities/coach-availability-override.entity';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

interface Trainer {
  token: string;
  userId: string;
  trainerProfileId: string;
}

interface Coach {
  token: string;
  userId: string;
  coachProfileId: string;
}

describe('Coach My Times + override log (e2e, US-01.10)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    app = ctx.app;
  }, 180000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeTrainer = async (email: string, businessName: string): Promise<Trainer> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName }));
    return { token: await login(email), userId: user.id, trainerProfileId: profile.id };
  };

  const makeCoach = async (email: string, trainerProfileId: string): Promise<Coach> => {
    const user = await createUser(ctx.dataSource, {
      role: Role.Coach,
      email,
      firstName: 'Sam',
      lastName: 'Coach',
    });
    const repo = ctx.dataSource.getRepository(CoachProfile);
    const profile = await repo.save(
      repo.create({
        userId: user.id,
        trainerProfileId,
        publicVisible: false,
        joinedAt: new Date(),
      }),
    );
    return { token: await login(email), userId: user.id, coachProfileId: profile.id };
  };

  const MON_4_TO_8 = { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' };
  const SAT_9_TO_12 = { dayOfWeek: 6, startTime: '09:00', endTime: '12:00' };

  it('a coach sets, reads back and replaces their weekly availability', async () => {
    const trainer = await makeTrainer('t1@example.com', 'Elite Hoops');
    const coach = await makeCoach('c1@example.com', trainer.trainerProfileId);

    const saved = await request(app.getHttpServer())
      .put('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .send({ slots: [MON_4_TO_8, SAT_9_TO_12] })
      .expect(200);
    expect(saved.body).toEqual([
      { dayOfWeek: 1, startTime: '16:00', endTime: '20:00', isAvailable: true },
      { dayOfWeek: 6, startTime: '09:00', endTime: '12:00', isAvailable: true },
    ]);

    const read = await request(app.getHttpServer())
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .expect(200);
    expect(read.body).toHaveLength(2);

    // PUT replaces rather than appends.
    await request(app.getHttpServer())
      .put('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .send({ slots: [SAT_9_TO_12] })
      .expect(200);
    const rows = await ctx.dataSource
      .getRepository(AvailabilitySlot)
      .find({ where: { coachProfileId: coach.coachProfileId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].playerProfileId).toBeNull();
  });

  it('accepts multiple windows on one day (Monday 4-6pm AND 7-9pm)', async () => {
    const trainer = await makeTrainer('t2@example.com', 'Elite Hoops');
    const coach = await makeCoach('c2@example.com', trainer.trainerProfileId);

    const res = await request(app.getHttpServer())
      .put('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .send({
        slots: [
          { dayOfWeek: 1, startTime: '16:00', endTime: '18:00' },
          { dayOfWeek: 1, startTime: '19:00', endTime: '21:00' },
        ],
      })
      .expect(200);

    expect(res.body).toHaveLength(2);
  });

  it('rejects overlapping windows on the same day', async () => {
    const trainer = await makeTrainer('t3@example.com', 'Elite Hoops');
    const coach = await makeCoach('c3@example.com', trainer.trainerProfileId);

    const res = await request(app.getHttpServer())
      .put('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .send({
        slots: [
          { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' },
          { dayOfWeek: 1, startTime: '18:00', endTime: '21:00' },
        ],
      })
      .expect(400);

    expect(res.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('keeps player and coach availability in separate lanes on the shared table', async () => {
    const trainer = await makeTrainer('t4@example.com', 'Elite Hoops');
    const coach = await makeCoach('c4@example.com', trainer.trainerProfileId);
    const parent = await ctx.registerVerifiedPlayer({ email: 'parent4@example.com' });
    const parentToken = await login(parent.email);

    const playerRepo = ctx.dataSource.getRepository(PlayerProfile);
    const selfProfileId = (
      await playerRepo.save(
        playerRepo.create({ ownerUserId: parent.userId, displayName: 'Pat Parent' }),
      )
    ).id;

    await request(app.getHttpServer())
      .put(`/api/v1/players/${selfProfileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '11:00' }] })
      .expect(200);
    await request(app.getHttpServer())
      .put('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .send({ slots: [MON_4_TO_8] })
      .expect(200);

    // Each side sees only its own rows even though both live in
    // availability_slots.
    const coachRead = await request(app.getHttpServer())
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${coach.token}`)
      .expect(200);
    expect(coachRead.body).toEqual([
      { dayOfWeek: 1, startTime: '16:00', endTime: '20:00', isAvailable: true },
    ]);

    const parentRead = await request(app.getHttpServer())
      .get(`/api/v1/players/${selfProfileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(parentRead.body).toEqual([
      { dayOfWeek: 2, startTime: '10:00', endTime: '11:00', isAvailable: true },
    ]);
  });

  it('a player/parent cannot reach the coach endpoints', async () => {
    const parent = await ctx.registerVerifiedPlayer({ email: 'parent5@example.com' });
    const parentToken = await login(parent.email);

    await request(app.getHttpServer())
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(403);
  });

  it('a coach with availability but no profile row gets a clear error', async () => {
    const stray = await createUser(ctx.dataSource, { role: Role.Coach, email: 'c6@example.com' });
    expect(stray.id).toBeDefined();
    const token = await login('c6@example.com');

    const res = await request(app.getHttpServer())
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(res.body.errorCode).toBe(ErrorCode.COACH_PROFILE_NOT_FOUND);
  });

  describe('trainer assignment flow', () => {
    const setup = async (suffix: string): Promise<{ trainer: Trainer; coach: Coach }> => {
      const trainer = await makeTrainer(`ta${suffix}@example.com`, 'Elite Hoops');
      const coach = await makeCoach(`ca${suffix}@example.com`, trainer.trainerProfileId);
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set('Authorization', `Bearer ${coach.token}`)
        .send({ slots: [MON_4_TO_8] })
        .expect(200);
      return { trainer, coach };
    };

    it('reports no conflict inside the stated window', async () => {
      const { trainer, coach } = await setup('1');

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/trainers/me/coaches/${coach.coachProfileId}/availability/conflict-check?dayOfWeek=1&startTime=17:00&endTime=18:00`,
        )
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);

      expect(res.body).toMatchObject({ available: true, message: null });
    });

    it('warns with the coach name outside the stated window', async () => {
      const { trainer, coach } = await setup('2');

      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/trainers/me/coaches/${coach.coachProfileId}/availability/conflict-check?dayOfWeek=1&startTime=21:00&endTime=22:00`,
        )
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);

      expect(res.body.available).toBe(false);
      expect(res.body.message).toBe(
        'Coach Sam Coach is not available at this time per their schedule. Continue anyway?',
      );
    });

    it('records the override, notifies the coach and shows it to both sides', async () => {
      const { trainer, coach } = await setup('3');

      const created = await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${trainer.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
          overrideReason: 'Only coach certified for this age group.',
        })
        .expect(201);

      expect(created.body).toMatchObject({
        coachProfileId: coach.coachProfileId,
        trainerProfileId: trainer.trainerProfileId,
        overriddenByUserId: trainer.userId,
        overrideReason: 'Only coach certified for this age group.',
        eventId: null,
      });

      // Logged with the four fields US-01.10 names.
      const rows = await ctx.dataSource.getRepository(CoachAvailabilityOverride).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        coachProfileId: coach.coachProfileId,
        overriddenByUserId: trainer.userId,
        eventId: null,
      });

      expect(ctx.mailer.sendCoachAvailabilityOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'ca3@example.com',
          trainerName: 'Elite Hoops',
          dayName: 'Monday',
          reason: 'Only coach certified for this age group.',
        }),
      );

      const trainerList = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(trainerList.body).toHaveLength(1);

      const coachList = await request(app.getHttpServer())
        .get('/api/v1/coaches/me/availability/overrides')
        .set('Authorization', `Bearer ${coach.token}`)
        .expect(200);
      expect(coachList.body).toHaveLength(1);
      expect(coachList.body[0].overrideReason).toBe('Only coach certified for this age group.');
    });

    it('requires a reason', async () => {
      const { trainer, coach } = await setup('4');

      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${trainer.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
        })
        .expect(422);

      expect(await ctx.dataSource.getRepository(CoachAvailabilityOverride).count()).toBe(0);
    });

    it('rejects a blank reason', async () => {
      const { trainer, coach } = await setup('5');

      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${trainer.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
          overrideReason: '   ',
        })
        .expect(422);
    });

    it('cannot check or override a coach in another organisation', async () => {
      const { coach } = await setup('6');
      const outsider = await makeTrainer('outsider@example.com', 'Rival Hoops');

      await request(app.getHttpServer())
        .get(
          `/api/v1/trainers/me/coaches/${coach.coachProfileId}/availability/conflict-check?dayOfWeek=1&startTime=17:00&endTime=18:00`,
        )
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);

      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
          overrideReason: 'Trying to poach another org coach.',
        })
        .expect(404);

      expect(await ctx.dataSource.getRepository(CoachAvailabilityOverride).count()).toBe(0);
    });

    it('a coach cannot file an override against themselves', async () => {
      const { coach } = await setup('7');

      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${coach.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
          overrideReason: 'Self-approving my own schedule.',
        })
        .expect(403);
    });

    it("a trainer can read a coach's stated availability", async () => {
      const { trainer, coach } = await setup('8');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/trainers/me/coaches/${coach.coachProfileId}/availability`)
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        coachProfileId: coach.coachProfileId,
        displayName: 'Sam Coach',
      });
      expect(res.body.slots).toHaveLength(1);
    });
  });
});
