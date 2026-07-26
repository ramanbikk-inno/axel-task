import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { CoachProfile, CoachStatus } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Beyond the happy path: resending an expired invitation, revoking one that went
 * astray, ending an engagement, and re-hiring a coach. "Active under one
 * trainer" is about current employment — reading it as "never worked anywhere"
 * refused every existing email and left no lifecycle at all.
 */
describe('Coach lifecycle (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const COACH_PASSWORD = 'C0achStr0ng!Pass';

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

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** A trainer account with a known password, so it can drive the API. */
  const makeTrainer = async (
    email: string,
    businessName: string,
  ): Promise<{ token: string; trainerProfileId: string; userId: string }> => {
    const users = ctx.dataSource.getRepository(User);
    const passwordHash = await ctx.passwords.hash(COACH_PASSWORD);
    const owner = await users.save(
      users.create({
        email,
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
        passwordHash,
      }),
    );
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await trainers.save(trainers.create({ userId: owner.id, businessName }));
    return {
      token: await login(email, COACH_PASSWORD),
      trainerProfileId: profile.id,
      userId: owner.id,
    };
  };

  const invite = async (token: string, email: string): Promise<{ id: string; code: string }> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/coaches/invitations')
      .set(auth(token))
      .send({ email })
      .expect(201);
    return { id: res.body.id as string, code: res.body.code as string };
  };

  const accept = (code: string): request.Test =>
    request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: COACH_PASSWORD, firstName: 'Cody', lastName: 'Coach' });

  /** Invite, accept, and verify the coach's email so they can sign in. */
  const hire = async (
    trainerToken: string,
    email: string,
  ): Promise<{ coachProfileId: string; userId: string }> => {
    const inv = await invite(trainerToken, email);
    await accept(inv.code).expect(201);
    const users = ctx.dataSource.getRepository(User);
    const coachUser = (await users.findOne({ where: { email } })) as User;
    await users.update({ id: coachUser.id }, { emailVerified: true });
    const profile = (await ctx.dataSource
      .getRepository(CoachProfile)
      .findOne({ where: { userId: coachUser.id, status: CoachStatus.Active } })) as CoachProfile;
    return { coachProfileId: profile.id, userId: coachUser.id };
  };

  describe('resending an invitation', () => {
    it('mints a new code and retires the old one', async () => {
      const trainer = await makeTrainer('t1@example.com', 'Alpha');
      const first = await invite(trainer.token, 'coach1@example.com');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${first.id}/resend`)
        .set(auth(trainer.token))
        .expect(200);

      expect(res.body.code).not.toBe(first.code);
      expect(res.body.email).toBe('coach1@example.com');
      expect(res.body.status).toBe('pending');

      // The superseded link must stop working: it may have gone somewhere the
      // trainer no longer intends to reach.
      await accept(first.code).expect(404);
      await accept(res.body.code as string).expect(201);
    });

    it('works after the original has expired', async () => {
      const trainer = await makeTrainer('t2@example.com', 'Beta');
      const first = await invite(trainer.token, 'coach2@example.com');

      ctx.clock.advance(8 * 24 * 60 * 60 * 1000);
      await accept(first.code).expect(410);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${first.id}/resend`)
        .set(auth(trainer.token))
        .expect(200);
      await accept(res.body.code as string).expect(201);
    });

    it('refuses to resend one that has been accepted', async () => {
      const trainer = await makeTrainer('t3@example.com', 'Gamma');
      const inv = await invite(trainer.token, 'coach3@example.com');
      await accept(inv.code).expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${inv.id}/resend`)
        .set(auth(trainer.token))
        .expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.INVITATION_ALREADY_ACCEPTED);
    });

    it("refuses another trainer's invitation with 404", async () => {
      const a = await makeTrainer('t4a@example.com', 'Delta');
      const b = await makeTrainer('t4b@example.com', 'Epsilon');
      const inv = await invite(a.token, 'coach4@example.com');

      // 404 rather than 403: the id must not confirm that an invitation exists
      // in someone else's organisation.
      await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${inv.id}/resend`)
        .set(auth(b.token))
        .expect(404);
    });
  });

  describe('revoking an invitation', () => {
    it('kills a live single-use link', async () => {
      const trainer = await makeTrainer('t5@example.com', 'Zeta');
      const inv = await invite(trainer.token, 'wrong.address@example.com');

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/coaches/invitations/${inv.id}`)
        .set(auth(trainer.token))
        .expect(200);
      expect(res.body.status).toBe('expired');

      // A misaddressed invite is live for seven days and grants a Coach
      // account inside the org, so it has to be revocable.
      await accept(inv.code).expect(404);
    });

    it('refuses to revoke one already accepted', async () => {
      const trainer = await makeTrainer('t6@example.com', 'Eta');
      const inv = await invite(trainer.token, 'coach6@example.com');
      await accept(inv.code).expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/invitations/${inv.id}`)
        .set(auth(trainer.token))
        .expect(409);
    });
  });

  describe('off-boarding', () => {
    it('ends the engagement, keeps the row, and cuts access immediately', async () => {
      const trainer = await makeTrainer('t7@example.com', 'Theta');
      const coach = await hire(trainer.token, 'coach7@example.com');
      const coachToken = await login('coach7@example.com', COACH_PASSWORD);

      await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(coachToken)).expect(200);

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(trainer.token))
        .expect(200);
      expect(res.body.status).toBe(CoachStatus.Inactive);
      expect(res.body.endedAt).not.toBeNull();

      // A coach's tenancy comes from this row; leaving a live token behind
      // would let them keep reading the org's roster until it expired.
      await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(coachToken)).expect(401);

      // The row survives, so the engagement stays in the record.
      const rows = await ctx.dataSource
        .getRepository(CoachProfile)
        .find({ where: { userId: coach.userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(CoachStatus.Inactive);
    });

    it('drops them from the roster but shows them on request', async () => {
      const trainer = await makeTrainer('t8@example.com', 'Iota');
      const coach = await hire(trainer.token, 'coach8@example.com');

      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(trainer.token))
        .expect(200);

      const active = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(trainer.token))
        .expect(200);
      expect(active.body).toHaveLength(0);

      const all = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .query({ includeInactive: true })
        .set(auth(trainer.token))
        .expect(200);
      expect(all.body).toHaveLength(1);
      expect(all.body[0].status).toBe(CoachStatus.Inactive);
    });

    it('re-signing in after off-boarding gives no organisation access', async () => {
      const trainer = await makeTrainer('t9@example.com', 'Kappa');
      const coach = await hire(trainer.token, 'coach9@example.com');
      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(trainer.token))
        .expect(200);

      // Revoking sessions is not enough on its own — a fresh login would mint
      // a new one. Tenancy is resolved per request from the active profile.
      const fresh = await login('coach9@example.com', COACH_PASSWORD);
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(auth(fresh))
        .expect(200);
      expect(me.body.trainerOrgId).toBeNull();
      expect(me.body.coachProfileId).toBeNull();
    });

    it("refuses another trainer's coach with 404", async () => {
      const a = await makeTrainer('t10a@example.com', 'Lambda');
      const b = await makeTrainer('t10b@example.com', 'Mu');
      const coach = await hire(a.token, 'coach10@example.com');

      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(b.token))
        .expect(404);
    });

    it('refuses to off-board twice', async () => {
      const trainer = await makeTrainer('t11@example.com', 'Nu');
      const coach = await hire(trainer.token, 'coach11@example.com');
      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(trainer.token))
        .expect(200);

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(trainer.token))
        .expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.COACH_ALREADY_INACTIVE);
    });
  });

  describe('hiring a coach who has worked before', () => {
    it('re-homes an off-boarded coach to a new trainer', async () => {
      const a = await makeTrainer('t12a@example.com', 'Xi');
      const b = await makeTrainer('t12b@example.com', 'Omicron');
      const coach = await hire(a.token, 'coach12@example.com');

      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(a.token))
        .expect(200);

      const inv = await invite(b.token, 'coach12@example.com');
      const res = await accept(inv.code).expect(201);
      // No new account, so nothing to verify — they sign in as they always did.
      expect(res.body.message).toMatch(/sign in/i);

      const rows = await ctx.dataSource
        .getRepository(CoachProfile)
        .find({ where: { userId: coach.userId }, order: { joinedAt: 'ASC' } });
      // Both engagements survive: the old one ended, the new one is live.
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.status === CoachStatus.Active)).toHaveLength(1);

      const roster = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(b.token))
        .expect(200);
      expect(roster.body).toHaveLength(1);
    });

    it('refuses to poach a coach who is still active elsewhere', async () => {
      const a = await makeTrainer('t13a@example.com', 'Pi');
      const b = await makeTrainer('t13b@example.com', 'Rho');
      await hire(a.token, 'coach13@example.com');

      const inv = await invite(b.token, 'coach13@example.com');
      const res = await accept(inv.code).expect(409);

      // The rule that does hold: one *active* trainer at a time.
      expect(res.body.errorCode).toBe(ErrorCode.COACH_ACTIVE_ELSEWHERE);
    });

    it('refuses to turn a non-coach account into a coach', async () => {
      const trainer = await makeTrainer('t14@example.com', 'Sigma');
      const parent = await ctx.registerVerifiedPlayer({ email: 'parent14@example.com' });

      const inv = await invite(trainer.token, parent.email);
      const res = await accept(inv.code).expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
    });

    it('refuses a coach already active in the same organisation', async () => {
      const trainer = await makeTrainer('t15@example.com', 'Tau');
      await hire(trainer.token, 'coach15@example.com');

      const inv = await invite(trainer.token, 'coach15@example.com');
      await accept(inv.code).expect(409);
    });
  });
});
