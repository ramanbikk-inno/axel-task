import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { ShareLink } from '../src/modules/enrollment/entities/share-link.entity';
import { TrainerPlayerAssociation } from '../src/modules/enrollment/entities/trainer-player-association.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { FACTORY_PASSWORD } from './helpers/user.factory';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('ShareLink registration + multi-trainer (e2e, US-01.02)', () => {
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

  const createTrainer = async (
    email: string,
    businessName: string,
  ): Promise<{ token: string; userId: string; trainerProfileId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const profile = await ctx.dataSource.getRepository(TrainerProfile).save(
      ctx.dataSource.getRepository(TrainerProfile).create({
        userId: user.id,
        businessName,
      }),
    );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return {
      token: login.body.accessToken as string,
      userId: user.id,
      trainerProfileId: profile.id,
    };
  };

  const makeShareLink = async (trainerToken: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set('Authorization', `Bearer ${trainerToken}`)
      .send({})
      .expect(201);
    expect(res.body.code).toBeTruthy();
    expect(res.body.url).toContain(`/join/${res.body.code}`);
    return res.body.code as string;
  };

  it('trainer generates a link; a new player registers, gets a profile + association, then verifies & logs in', async () => {
    const trainer = await createTrainer('coach1@example.com', 'Hoops Academy');
    const code = await makeShareLink(trainer.token);

    // Public resolve shows the trainer name.
    const resolved = await request(app.getHttpServer())
      .get(`/api/v1/sharelinks/${code}`)
      .expect(200);
    expect(resolved.body.valid).toBe(true);
    expect(resolved.body.trainer.businessName).toBe('Hoops Academy');

    const playerEmail = 'newplayer@example.com';
    const reg = await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({
        birthDate: '1994-03-22',
        email: playerEmail,
        password: 'Str0ng!Passw0rd',
        firstName: 'Nate',
        lastName: 'New',
        gender: 'male',
      })
      .expect(201);
    expect(reg.body.trainerProfileId).toBe(trainer.trainerProfileId);
    expect(reg.body.playerProfileId).toBeTruthy();

    // A self profile + one association were created.
    const profiles = await ctx.dataSource
      .getRepository(PlayerProfile)
      .find({ where: { displayName: 'Nate New' } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].isChild).toBe(false);

    const assocs = await ctx.dataSource.getRepository(TrainerPlayerAssociation).find();
    expect(assocs).toHaveLength(1);
    expect(assocs[0].trainerProfileId).toBe(trainer.trainerProfileId);

    // Confirmation + verification emails sent; link use count incremented.
    expect(ctx.mailer.sendJoinConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ to: playerEmail, trainerName: 'Hoops Academy' }),
    );
    const link = await ctx.dataSource.getRepository(ShareLink).findOne({ where: { code } });
    expect(link?.useCount).toBe(1);

    // Verify email (token from the verification mail) then log in.
    const verifyUrl =
      ctx.mailer.sendVerification.mock.calls[ctx.mailer.sendVerification.mock.calls.length - 1][0]
        .verifyUrl;
    const token = new URL(verifyUrl).searchParams.get('token') as string;
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: playerEmail, password: 'Str0ng!Passw0rd' })
      .expect(200);
  });

  it('an existing player joins a second trainer without a duplicate account (multi-trainer)', async () => {
    const trainerA = await createTrainer('a@example.com', 'Alpha Academy');
    const trainerB = await createTrainer('b@example.com', 'Beta Ballers');
    const codeA = await makeShareLink(trainerA.token);
    const codeB = await makeShareLink(trainerB.token);

    const player = await ctx.registerVerifiedPlayer({ email: 'multi@example.com' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const playerToken = login.body.accessToken as string;

    // Join A, then B.
    await request(app.getHttpServer())
      .post(`/api/v1/join/${codeA}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .expect(200);
    const joinB = await request(app.getHttpServer())
      .post(`/api/v1/join/${codeB}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .expect(200);
    expect(joinB.body.trainerProfileId).toBe(trainerB.trainerProfileId);

    // Exactly one account + one self profile, but two associations.
    const users = await ctx.dataSource.getRepository(User).find({ where: { email: player.email } });
    expect(users).toHaveLength(1);
    const profiles = await ctx.dataSource
      .getRepository(PlayerProfile)
      .find({ where: { ownerUserId: player.userId } });
    expect(profiles).toHaveLength(1);
    const assocs = await ctx.dataSource
      .getRepository(TrainerPlayerAssociation)
      .find({ where: { playerProfileId: profiles[0].id } });
    expect(assocs).toHaveLength(2);

    // Re-joining B is idempotent (still two associations).
    const again = await request(app.getHttpServer())
      .post(`/api/v1/join/${codeB}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .expect(200);
    expect(again.body.message).toMatch(/already connected/i);
    const assocs2 = await ctx.dataSource
      .getRepository(TrainerPlayerAssociation)
      .find({ where: { playerProfileId: profiles[0].id } });
    expect(assocs2).toHaveLength(2);
  });

  it('registering with an existing email is rejected (log in to join instead)', async () => {
    const trainer = await createTrainer('coach2@example.com', 'Dup Academy');
    const code = await makeShareLink(trainer.token);
    await ctx.registerVerifiedPlayer({ email: 'taken@example.com' });

    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({
        email: 'taken@example.com',
        password: 'Str0ng!Passw0rd',
        firstName: 'Dup',
        birthDate: '1994-03-22',
      })
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS));
  });

  it('an invalid code is rejected', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/join/nope-not-real/register`)
      .send({ email: 'x@example.com', password: 'Str0ng!Passw0rd', birthDate: '1994-03-22' })
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_INVALID));

    const resolved = await request(app.getHttpServer())
      .get('/api/v1/sharelinks/nope-not-real')
      .expect(200);
    expect(resolved.body.valid).toBe(false);
    expect(resolved.body.trainer).toBeNull();
  });

  it('non-trainers cannot generate ShareLinks', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({})
      .expect(403);
  });
});
