import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Parent creates child profile (e2e, US-01.03)', () => {
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

  // Register a parent via a ShareLink and return an authenticated token.
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

  it('creates a child connected to the parent`s trainer and lists the family', async () => {
    const trainerA = await createTrainerWithLink('ta@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent@example.com', trainerA.code);

    const created = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        displayName: 'Maya Parent',
        birthDate: '2014-08-01',
        gender: 'female',
        trainerProfileIds: [trainerA.trainerProfileId],
      })
      .expect(201);
    expect(created.body.isChild).toBe(true);
    expect(created.body.displayName).toBe('Maya Parent');
    expect(created.body.trainers).toHaveLength(1);
    expect(created.body.trainers[0].trainerProfileId).toBe(trainerA.trainerProfileId);
    expect(created.body.trainers[0].businessName).toBe('Alpha Academy');

    const family = await request(app.getHttpServer())
      .get('/api/v1/players')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    // self + child
    expect(family.body).toHaveLength(2);
    const self = family.body.find((p: { isChild: boolean }) => !p.isChild);
    const child = family.body.find((p: { isChild: boolean }) => p.isChild);
    expect(self.trainers).toHaveLength(1); // parent joined trainer A
    expect(child.displayName).toBe('Maya Parent');
  });

  it('creates a child with no trainer association when none requested', async () => {
    const trainerA = await createTrainerWithLink('ta2@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent2@example.com', trainerA.code);

    const created = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ displayName: 'Solo Kid', birthDate: '2015-03-03', gender: 'male' })
      .expect(201);
    expect(created.body.trainers).toHaveLength(0);
  });

  it('rejects an out-of-range age (>18 or <1)', async () => {
    const trainerA = await createTrainerWithLink('ta3@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent3@example.com', trainerA.code);

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ displayName: 'Too Old', birthDate: '2000-01-01', gender: 'male' })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_AGE_INVALID));

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ displayName: 'Not Born', birthDate: '2026-06-01', gender: 'female' })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_AGE_INVALID));
  });

  it('rejects a duplicate child (same name + birth date)', async () => {
    const trainerA = await createTrainerWithLink('ta4@example.com', 'Alpha Academy');
    const parentToken = await registerParent('parent4@example.com', trainerA.code);
    const body = { displayName: 'Twin Kid', birthDate: '2016-02-02', gender: 'female' };

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send(body)
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.DUPLICATE_CHILD));
  });

  it('refuses to connect a child to a trainer the parent is not associated with', async () => {
    const trainerA = await createTrainerWithLink('ta5@example.com', 'Alpha Academy');
    const trainerB = await createTrainerWithLink('tb5@example.com', 'Beta Ballers');
    const parentToken = await registerParent('parent5@example.com', trainerA.code);

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        displayName: 'Wrong Trainer',
        birthDate: '2015-05-05',
        gender: 'male',
        trainerProfileIds: [trainerB.trainerProfileId],
      })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.TRAINER_NOT_ASSOCIATED));
  });

  it('forbids non-parents from creating child profiles', async () => {
    const user = await createUser(ctx.dataSource, {
      role: Role.Trainer,
      email: 'notparent@example.com',
    });
    await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(
        ctx.dataSource.getRepository(TrainerProfile).create({ userId: user.id, businessName: 'X' }),
      );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'notparent@example.com', password: FACTORY_PASSWORD })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ displayName: 'Nope', birthDate: '2015-01-01', gender: 'male' })
      .expect(403);
  });
});
