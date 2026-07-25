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
        hadConflict: true,
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
      expect(trainerList.body).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(trainerList.body.items).toHaveLength(1);

      const coachList = await request(app.getHttpServer())
        .get('/api/v1/coaches/me/availability/overrides')
        .set('Authorization', `Bearer ${coach.token}`)
        .expect(200);
      expect(coachList.body.items).toHaveLength(1);
      expect(coachList.body.items[0].overrideReason).toBe(
        'Only coach certified for this age group.',
      );
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
  describe('review regressions', () => {
    it('serialises concurrent replaces so overlapping windows cannot persist', async () => {
      const trainer = await makeTrainer('tr1@example.com', 'Elite Hoops');
      const coach = await makeCoach('cr1@example.com', trainer.trainerProfileId);

      // Each set is individually valid; together they overlap. Before the owner
      // lock all four landed, leaving the DB in a state the API rejects.
      await Promise.all(
        [16, 17, 18, 19].map((h) =>
          request(app.getHttpServer())
            .put('/api/v1/coaches/me/availability')
            .set('Authorization', `Bearer ${coach.token}`)
            .send({ slots: [{ dayOfWeek: 1, startTime: `${h}:00`, endTime: `${h + 2}:00` }] }),
        ),
      );

      const rows = await ctx.dataSource
        .getRepository(AvailabilitySlot)
        .find({ where: { coachProfileId: coach.coachProfileId } });
      expect(rows).toHaveLength(1);
    });

    it('a blackout hides a player from the trainer time filter', async () => {
      const trainer = await makeTrainer('tr2@example.com', 'Elite Hoops');
      const parent = await ctx.registerVerifiedPlayer({ email: 'pr2@example.com' });
      const parentToken = await login(parent.email);
      const playerRepo = ctx.dataSource.getRepository(PlayerProfile);
      const player = await playerRepo.save(
        playerRepo.create({ ownerUserId: parent.userId, displayName: 'Amy' }),
      );
      await ctx.dataSource.query(
        `INSERT INTO trainer_player_associations (trainer_profile_id, player_profile_id, status, connected_at)
         VALUES ($1, $2, 'active', now())`,
        [trainer.trainerProfileId, player.id],
      );

      await request(app.getHttpServer())
        .put(`/api/v1/players/${player.id}/availability`)
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' },
            { dayOfWeek: 1, startTime: '17:00', endTime: '18:00', isAvailable: false },
          ],
        })
        .expect(200);

      const blacked = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?dayOfWeek=1&time=17:30')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(blacked.body).toHaveLength(0);

      // Still free either side of the hole.
      const free = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?dayOfWeek=1&time=18:30')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(free.body).toHaveLength(1);
    });

    it('a blackout on one day does not suppress a match on another', async () => {
      const trainer = await makeTrainer('tr3@example.com', 'Elite Hoops');
      const parent = await ctx.registerVerifiedPlayer({ email: 'pr3@example.com' });
      const parentToken = await login(parent.email);
      const playerRepo = ctx.dataSource.getRepository(PlayerProfile);
      const player = await playerRepo.save(
        playerRepo.create({ ownerUserId: parent.userId, displayName: 'Amy' }),
      );
      await ctx.dataSource.query(
        `INSERT INTO trainer_player_associations (trainer_profile_id, player_profile_id, status, connected_at)
         VALUES ($1, $2, 'active', now())`,
        [trainer.trainerProfileId, player.id],
      );

      await request(app.getHttpServer())
        .put(`/api/v1/players/${player.id}/availability`)
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' },
            { dayOfWeek: 2, startTime: '17:00', endTime: '18:00', isAvailable: false },
          ],
        })
        .expect(200);

      // No dayOfWeek filter: Tuesday's blackout must not veto Monday.
      const res = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?time=17:30')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
    });

    it('flags an override that did not actually conflict, and skips the email', async () => {
      const trainer = await makeTrainer('tr4@example.com', 'Elite Hoops');
      const coach = await makeCoach('cr4@example.com', trainer.trainerProfileId);
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set('Authorization', `Bearer ${coach.token}`)
        .send({ slots: [MON_4_TO_8] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${trainer.token}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '17:00',
          endTime: '18:00',
          overrideReason: 'Client thought this clashed but it does not.',
        })
        .expect(201);

      expect(res.body.hadConflict).toBe(false);
      expect(ctx.mailer.sendCoachAvailabilityOverride).not.toHaveBeenCalled();
    });

    it('lets a Super Admin read the trail across organisations but not write to it', async () => {
      const trainer = await makeTrainer('tr5@example.com', 'Elite Hoops');
      const coach = await makeCoach('cr5@example.com', trainer.trainerProfileId);
      await request(app.getHttpServer())
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

      await ctx.seedSuperAdmin();
      const adminLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: ctx.superAdminEmail, password: ctx.superAdminPassword })
        .expect(200);
      const adminToken = adminLogin.body.accessToken as string;

      const list = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(list.body.total).toBe(1);

      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          coachProfileId: coach.coachProfileId,
          dayOfWeek: 1,
          startTime: '21:00',
          endTime: '22:00',
          overrideReason: 'Platform admin should not schedule.',
        })
        .expect(403);
    });

    it('pages the override trail', async () => {
      const trainer = await makeTrainer('tr6@example.com', 'Elite Hoops');
      const coach = await makeCoach('cr6@example.com', trainer.trainerProfileId);
      for (const hour of [21, 22]) {
        await request(app.getHttpServer())
          .post('/api/v1/coach-overrides')
          .set('Authorization', `Bearer ${trainer.token}`)
          .send({
            coachProfileId: coach.coachProfileId,
            dayOfWeek: 1,
            startTime: `${hour}:00`,
            endTime: `${hour}:30`,
            overrideReason: 'Short-notice cover needed.',
          })
          .expect(201);
      }

      const firstPage = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides?page=1&limit=1')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(firstPage.body).toMatchObject({ total: 2, page: 1, limit: 1 });
      expect(firstPage.body.items).toHaveLength(1);

      const secondPage = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides?page=2&limit=1')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(secondPage.body.items).toHaveLength(1);
      expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items[0].id);
    });
    it('a fully blacked-out day is not offered by the day-only filter either', async () => {
      const trainer = await makeTrainer('tr7@example.com', 'Elite Hoops');
      const parent = await ctx.registerVerifiedPlayer({ email: 'pr7@example.com' });
      const parentToken = await login(parent.email);
      const playerRepo = ctx.dataSource.getRepository(PlayerProfile);
      const player = await playerRepo.save(
        playerRepo.create({ ownerUserId: parent.userId, displayName: 'Amy' }),
      );
      await ctx.dataSource.query(
        `INSERT INTO trainer_player_associations (trainer_profile_id, player_profile_id, status, connected_at)
         VALUES ($1, $2, 'active', now())`,
        [trainer.trainerProfileId, player.id],
      );

      await request(app.getHttpServer())
        .put(`/api/v1/players/${player.id}/availability`)
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' },
            { dayOfWeek: 1, startTime: '16:00', endTime: '20:00', isAvailable: false },
          ],
        })
        .expect(200);

      // Day-only and day+time must agree: neither should offer this player.
      const dayOnly = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?dayOfWeek=1')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(dayOnly.body).toHaveLength(0);

      const withTime = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?dayOfWeek=1&time=17:00')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(withTime.body).toHaveLength(0);
    });

    it('a partially blacked-out day is still offered by the day-only filter', async () => {
      const trainer = await makeTrainer('tr8@example.com', 'Elite Hoops');
      const parent = await ctx.registerVerifiedPlayer({ email: 'pr8@example.com' });
      const parentToken = await login(parent.email);
      const playerRepo = ctx.dataSource.getRepository(PlayerProfile);
      const player = await playerRepo.save(
        playerRepo.create({ ownerUserId: parent.userId, displayName: 'Amy' }),
      );
      await ctx.dataSource.query(
        `INSERT INTO trainer_player_associations (trainer_profile_id, player_profile_id, status, connected_at)
         VALUES ($1, $2, 'active', now())`,
        [trainer.trainerProfileId, player.id],
      );

      await request(app.getHttpServer())
        .put(`/api/v1/players/${player.id}/availability`)
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '16:00', endTime: '20:00' },
            { dayOfWeek: 1, startTime: '17:00', endTime: '18:00', isAvailable: false },
          ],
        })
        .expect(200);

      const dayOnly = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/players/availability?dayOfWeek=1')
        .set('Authorization', `Bearer ${trainer.token}`)
        .expect(200);
      expect(dayOnly.body).toHaveLength(1);
    });

    it("hands the writer back its own set, not a concurrent writer's", async () => {
      const trainer = await makeTrainer('tr9@example.com', 'Elite Hoops');
      const coach = await makeCoach('cr9@example.com', trainer.trainerProfileId);

      const responses = await Promise.all(
        [16, 17, 18, 19].map((h) =>
          request(app.getHttpServer())
            .put('/api/v1/coaches/me/availability')
            .set('Authorization', `Bearer ${coach.token}`)
            .send({ slots: [{ dayOfWeek: 1, startTime: `${h}:00`, endTime: `${h + 2}:00` }] })
            .then((res) => ({ sent: `${h}:00`, body: res.body })),
        ),
      );

      // The read-back runs in the writing transaction, so each caller sees the
      // set it submitted even though only the last one survives.
      for (const r of responses) {
        expect(r.body).toHaveLength(1);
        expect(r.body[0].startTime).toBe(r.sent);
      }
    });
  });
});
