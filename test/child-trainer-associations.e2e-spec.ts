import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { TrainerPlayerAssociation } from '../src/modules/enrollment/entities/trainer-player-association.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Parent manages child-trainer associations (e2e)', () => {
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

  const createTrainerWithLink = async (
    email: string,
    businessName: string,
  ): Promise<{ trainerProfileId: string; code: string }> => {
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
    return { trainerProfileId: profile.id, code: link.body.code as string };
  };

  const registerParent = async (email: string, code: string): Promise<string> => {
    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({
        email,
        password: 'Str0ng!Passw0rd',
        firstName: 'Pat',
        lastName: 'Parent',
        birthDate: '1994-03-22',
      })
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

  const createChild = async (token: string, name: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: name, birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    return res.body.id as string;
  };

  it('adds a child to a NEW trainer via a ShareLink code', async () => {
    const trainerA = await createTrainerWithLink('a@example.com', 'Alpha Academy');
    const trainerB = await createTrainerWithLink('b@example.com', 'Beta Ballers');
    const parentToken = await registerParent('parent@example.com', trainerA.code); // parent has trainer A
    const childId = await createChild(parentToken, 'Kid One');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/players/${childId}/trainers/by-code`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ code: trainerB.code })
      .expect(200);
    expect(
      res.body.trainers.map((t: { trainerProfileId: string }) => t.trainerProfileId),
    ).toContain(trainerB.trainerProfileId);
  });

  it('adds a child to an EXISTING trainer from "My Trainers"', async () => {
    const trainerA = await createTrainerWithLink('a2@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent2@example.com', trainerA.code);
    const childId = await createChild(parentToken, 'Kid Two');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/players/${childId}/trainers`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ trainerProfileId: trainerA.trainerProfileId })
      .expect(200);
    expect(res.body.trainers).toHaveLength(1);
    expect(res.body.trainers[0].trainerProfileId).toBe(trainerA.trainerProfileId);
  });

  it('removes a child from a trainer (soft delete: association becomes inactive, row preserved)', async () => {
    const trainerA = await createTrainerWithLink('a3@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent3@example.com', trainerA.code);
    const childId = await createChild(parentToken, 'Kid Three');

    await request(app.getHttpServer())
      .post(`/api/v1/players/${childId}/trainers`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ trainerProfileId: trainerA.trainerProfileId })
      .expect(200);

    const removed = await request(app.getHttpServer())
      .delete(`/api/v1/players/${childId}/trainers/${trainerA.trainerProfileId}`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(removed.body.trainers).toHaveLength(0);

    // History preserved: the association row still exists, marked inactive.
    const assoc = await ctx.dataSource.getRepository(TrainerPlayerAssociation).findOne({
      where: { playerProfileId: childId, trainerProfileId: trainerA.trainerProfileId },
    });
    expect(assoc).not.toBeNull();
    expect(assoc?.status).toBe('inactive');
  });

  it('exposes context-switcher data (self + children with trainers)', async () => {
    const trainerA = await createTrainerWithLink('a4@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent4@example.com', trainerA.code);
    const childId = await createChild(parentToken, 'Kid Four');
    await request(app.getHttpServer())
      .post(`/api/v1/players/${childId}/trainers`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ trainerProfileId: trainerA.trainerProfileId })
      .expect(200);

    const ctxRes = await request(app.getHttpServer())
      .get('/api/v1/players/context')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(ctxRes.body.self).not.toBeNull();
    expect(ctxRes.body.self.trainers).toHaveLength(1); // parent joined A
    expect(ctxRes.body.children).toHaveLength(1);
    expect(ctxRes.body.children[0].trainers[0].businessName).toBe('Alpha Academy');
  });

  it('refuses adding to a trainer the parent has no relationship with (from My Trainers)', async () => {
    const trainerA = await createTrainerWithLink('a5@example.com', 'Alpha Academy');
    const trainerB = await createTrainerWithLink('b5@example.com', 'Beta Ballers');
    const parentToken = await registerParent('parent5@example.com', trainerA.code);
    const childId = await createChild(parentToken, 'Kid Five');

    await request(app.getHttpServer())
      .post(`/api/v1/players/${childId}/trainers`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ trainerProfileId: trainerB.trainerProfileId })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.TRAINER_NOT_ASSOCIATED));
  });

  it("refuses to manage another parent's profile", async () => {
    const trainerA = await createTrainerWithLink('a6@example.com', 'Alpha Academy');
    const parentA = await registerParent('pa@example.com', trainerA.code);
    const parentB = await registerParent('pb@example.com', trainerA.code);
    const childOfB = await createChild(parentB, 'B Kid');

    await request(app.getHttpServer())
      .post(`/api/v1/players/${childOfB}/trainers`)
      .set('Authorization', `Bearer ${parentA}`)
      .send({ trainerProfileId: trainerA.trainerProfileId })
      // 404, not 403: a 403 would confirm the id names a real profile
      // belonging to another family.
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.NOT_FOUND));
  });
});
