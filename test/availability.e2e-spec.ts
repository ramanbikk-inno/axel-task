import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Availability / Best Times (e2e, US-01.09)', () => {
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

  const makeTrainer = async (
    email: string,
    businessName: string,
  ): Promise<{ token: string; trainerProfileId: string; code: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const profile = await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(ctx.dataSource.getRepository(TrainerProfile).create({ userId: user.id, businessName }));
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    const link = await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({})
      .expect(201);
    return {
      token: login.body.accessToken as string,
      trainerProfileId: profile.id,
      code: link.body.code as string,
    };
  };

  const registerParent = async (email: string, code: string): Promise<string> => {
    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({ email, password: 'Str0ng!Passw0rd', firstName: 'Pat', lastName: 'Parent' })
      .expect(201);
    const verifyUrl =
      ctx.mailer.sendVerification.mock.calls[ctx.mailer.sendVerification.mock.calls.length - 1][0]
        .verifyUrl;
    const token = new URL(verifyUrl).searchParams.get('token') as string;
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Str0ng!Passw0rd' })
      .expect(200);
    return login.body.accessToken as string;
  };

  const selfProfileId = async (token: string): Promise<string> => {
    const family = await request(app.getHttpServer())
      .get('/api/v1/players')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return family.body.find((p: { isChild: boolean }) => !p.isChild).id as string;
  };

  it('player sets and reads their weekly availability', async () => {
    const trainer = await makeTrainer('t@example.com', 'Alpha');
    const parentToken = await registerParent('parent@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    const set = await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        slots: [
          { dayOfWeek: 1, startTime: '17:00', endTime: '20:00' },
          { dayOfWeek: 3, startTime: '18:00', endTime: '21:00' },
        ],
      })
      .expect(200);
    expect(set.body).toHaveLength(2);
    expect(set.body[0]).toMatchObject({ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' });

    // Re-setting replaces (not appends).
    const replaced = await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 6, startTime: '09:00', endTime: '12:00' }] })
      .expect(200);
    expect(replaced.body).toHaveLength(1);

    const got = await request(app.getHttpServer())
      .get(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(got.body).toHaveLength(1);
    expect(got.body[0].dayOfWeek).toBe(6);
  });

  it('rejects an inverted time range', async () => {
    const trainer = await makeTrainer('t2@example.com', 'Beta');
    const parentToken = await registerParent('parent2@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 1, startTime: '20:00', endTime: '17:00' }] })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR));
  });

  it('trainer sees associated players` availability and can filter by day/time', async () => {
    const trainer = await makeTrainer('t3@example.com', 'Gamma');
    const parentToken = await registerParent('parent3@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }] })
      .expect(200);

    const all = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0].slots[0]).toMatchObject({ dayOfWeek: 1, startTime: '17:00' });

    // Matches the filter (Monday 18:00).
    const match = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability?dayOfWeek=1&time=18:00')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(match.body).toHaveLength(1);

    // Does not match (Monday 21:00 is outside the window).
    const noMatch = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability?dayOfWeek=1&time=21:00')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(noMatch.body).toHaveLength(0);
  });

  it("refuses to set availability on another parent's profile", async () => {
    const trainer = await makeTrainer('t4@example.com', 'Delta');
    const parentA = await registerParent('pa@example.com', trainer.code);
    const parentB = await registerParent('pb@example.com', trainer.code);
    const profileB = await selfProfileId(parentB);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileB}/availability`)
      .set('Authorization', `Bearer ${parentA}`)
      .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }] })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.PROFILE_NOT_OWNED));
  });

  it('forbids non-trainers from the trainer availability view', async () => {
    const trainer = await makeTrainer('t5@example.com', 'Epsilon');
    const parentToken = await registerParent('parent5@example.com', trainer.code);

    await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(403);
  });

  it('rejects overlapping windows on the same day', async () => {
    const trainer = await makeTrainer('t6@example.com', 'Zeta');
    const parentToken = await registerParent('parent6@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        slots: [
          { dayOfWeek: 1, startTime: '17:00', endTime: '20:00' },
          { dayOfWeek: 1, startTime: '19:00', endTime: '21:00' },
        ],
      })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR));
  });

  it('allows adjacent (touching) windows on the same day', async () => {
    const trainer = await makeTrainer('t7@example.com', 'Eta');
    const parentToken = await registerParent('parent7@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        slots: [
          { dayOfWeek: 1, startTime: '17:00', endTime: '18:00' },
          { dayOfWeek: 1, startTime: '18:00', endTime: '19:00' },
        ],
      })
      .expect(200);
    expect(res.body).toHaveLength(2);
  });

  it('clears all availability when given an empty slot list', async () => {
    const trainer = await makeTrainer('t8@example.com', 'Theta');
    const parentToken = await registerParent('parent8@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '12:00' }] })
      .expect(200);

    const cleared = await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [] })
      .expect(200);
    expect(cleared.body).toHaveLength(0);

    const got = await request(app.getHttpServer())
      .get(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(got.body).toHaveLength(0);
  });

  it('accepts Sunday (dayOfWeek 0) and matches the trainer day filter', async () => {
    const trainer = await makeTrainer('t9@example.com', 'Iota');
    const parentToken = await registerParent('parent9@example.com', trainer.code);
    const profileId = await selfProfileId(parentToken);

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ slots: [{ dayOfWeek: 0, startTime: '09:00', endTime: '11:00' }] })
      .expect(200);

    const match = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability?dayOfWeek=0&time=10:00')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(match.body).toHaveLength(1);
    expect(match.body[0].slots[0]).toMatchObject({ dayOfWeek: 0, startTime: '09:00' });
  });

  it('returns an empty list for a trainer with no associated players', async () => {
    const trainer = await makeTrainer('t10@example.com', 'Kappa');

    const res = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/players/availability')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
