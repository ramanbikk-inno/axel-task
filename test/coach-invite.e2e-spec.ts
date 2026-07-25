import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

const COACH_PASSWORD = 'C0ach!Passw0rd';

describe('Trainer invites coach (e2e, US-01.08)', () => {
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
  ): Promise<{ token: string; trainerProfileId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const profile = await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(ctx.dataSource.getRepository(TrainerProfile).create({ userId: user.id, businessName }));
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return { token: login.body.accessToken as string, trainerProfileId: profile.id };
  };

  const invite = async (token: string, email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/coaches/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, message: 'Join my staff!' })
      .expect(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.email).toBe(email);
    return res.body.code as string;
  };

  it('invites a coach, coach accepts + verifies + logs in, appears in the roster', async () => {
    const trainer = await makeTrainer('coach.owner@example.com', 'Elite Hoops');
    const code = await invite(trainer.token, 'newcoach@example.com');
    expect(ctx.mailer.sendCoachInvite).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'newcoach@example.com', trainerName: 'Elite Hoops' }),
    );

    // Public resolve shows trainer + target email.
    const resolved = await request(app.getHttpServer())
      .get(`/api/v1/coaches/invitations/${code}`)
      .expect(200);
    expect(resolved.body.valid).toBe(true);
    expect(resolved.body.email).toBe('newcoach@example.com');
    expect(resolved.body.trainerName).toBe('Elite Hoops');

    // Accept (new coach sets a password).
    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: COACH_PASSWORD, firstName: 'Cody', lastName: 'Coach' })
      .expect(201);

    // A coach profile linked to the trainer now exists.
    const coachProfiles = await ctx.dataSource.getRepository(CoachProfile).find();
    expect(coachProfiles).toHaveLength(1);
    expect(coachProfiles[0].trainerProfileId).toBe(trainer.trainerProfileId);

    // Invitation is now "accepted".
    const invitations = await request(app.getHttpServer())
      .get('/api/v1/coaches/invitations')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(invitations.body[0].status).toBe('accepted');

    // Coach verifies email then logs in.
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
      .send({ email: 'newcoach@example.com', password: COACH_PASSWORD })
      .expect(200);

    // Coach shows up in the trainer's roster.
    const roster = await request(app.getHttpServer())
      .get('/api/v1/coaches')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(roster.body).toHaveLength(1);
    expect(roster.body[0].email).toBe('newcoach@example.com');
  });

  it('is single-use: accepting the same invite twice fails', async () => {
    const trainer = await makeTrainer('t2@example.com', 'Beta Ballers');
    const code = await invite(trainer.token, 'coach2@example.com');

    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: COACH_PASSWORD })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: COACH_PASSWORD })
      .expect(410)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_EXPIRED));
  });

  // Still a 409 refusal; the code is now specific about *why*, because an
  // off-boarded coach with the same email is a case that must succeed.
  it('enforces one ACTIVE trainer per coach: a second trainer cannot poach one', async () => {
    const trainerA = await makeTrainer('ta@example.com', 'Alpha');
    const trainerB = await makeTrainer('tb@example.com', 'Beta');
    const codeA = await invite(trainerA.token, 'shared@example.com');
    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${codeA}/accept`)
      .send({ password: COACH_PASSWORD })
      .expect(201);

    const codeB = await invite(trainerB.token, 'shared@example.com');
    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${codeB}/accept`)
      .send({ password: COACH_PASSWORD })
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.COACH_ACTIVE_ELSEWHERE));
  });

  it('expires after 7 days', async () => {
    const trainer = await makeTrainer('t3@example.com', 'Gamma');
    const code = await invite(trainer.token, 'late@example.com');

    ctx.clock.advance(8 * 24 * 60 * 60 * 1000);

    const resolved = await request(app.getHttpServer())
      .get(`/api/v1/coaches/invitations/${code}`)
      .expect(200);
    expect(resolved.body.valid).toBe(false);

    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: COACH_PASSWORD })
      .expect(410)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_EXPIRED));

    const invitations = await request(app.getHttpServer())
      .get('/api/v1/coaches/invitations')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(invitations.body[0].status).toBe('expired');
  });

  it('forbids non-trainers from inviting coaches', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'np@example.com' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/coaches/invitations')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ email: 'x@example.com' })
      .expect(403);
  });
});
