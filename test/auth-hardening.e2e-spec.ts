import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { RefreshToken } from '../src/modules/auth/entities/refresh-token.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * The login cases matter most: applying the password-complexity policy to
 * *login* returned 422 quoting the policy for a wrong password of the wrong
 * shape and 401 for the right shape, leaking the policy and making failed
 * logins distinguishable.
 */
describe('Auth hardening (e2e)', () => {
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

  const login = (email: string, password: string): request.Test =>
    request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });

  describe('login does not enforce the password policy', () => {
    it.each([
      ['short', 'abc'],
      ['no symbol', 'alllowercase1'],
      ['no digit', 'NoDigitsHere!'],
      ['no letters', '1234567890!@#$'],
      ['a single space', ' '],
    ])('answers a wrong password that is %s with a generic 401', async (_label, password) => {
      const player = await ctx.registerVerifiedPlayer({ email: 'shape@example.com' });

      const res = await login(player.email, password).expect(401);
      expect(res.body.errorCode).toBe(ErrorCode.INVALID_CREDENTIALS);
      // No hint about what a valid password would look like.
      expect(JSON.stringify(res.body)).not.toMatch(/upper|lower|symbol|character/i);
    });

    it('is indistinguishable between a wrong-shape and a right-shape wrong password', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'same@example.com' });

      const wrongShape = await login(player.email, 'abc');
      const rightShape = await login(player.email, 'C0mpletelyWr0ng!');

      // requestId and timestamp are per-request by design; everything else the
      // caller can see must match, or the shape of the guess is observable.
      const comparable = (body: Record<string, unknown>): Record<string, unknown> => {
        const { requestId: _r, timestamp: _t, ...rest } = body;
        return rest;
      };

      expect(wrongShape.status).toBe(rightShape.status);
      expect(comparable(wrongShape.body)).toEqual(comparable(rightShape.body));
    });

    it('still refuses an over-long password rather than hashing it', async () => {
      // The one bound login keeps: argon2id cost is attacker-controlled otherwise.
      const player = await ctx.registerVerifiedPlayer({ email: 'long@example.com' });
      await login(player.email, 'x'.repeat(129)).expect(422);
    });

    it('a correct password still logs in', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'good@example.com' });
      const res = await login(player.email, player.password).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
    });
  });

  describe('password change during impersonation', () => {
    const adminToken = async (): Promise<string> => {
      const sa = await ctx.seedSuperAdmin();
      const res = await login(sa.email, sa.password).expect(200);
      return res.body.accessToken as string;
    };

    it('is refused, and leaves the target account and its sessions untouched', async () => {
      const admin = await adminToken();
      const player = await ctx.registerVerifiedPlayer({ email: 'target@example.com' });

      const started = await request(app.getHttpServer())
        .post(`/api/v1/users/${player.userId}/impersonate`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ reason: 'support call' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${started.body.accessToken}`)
        // The realistic case: on a support call the user reads their own
        // password out, so knowing it is not the safeguard it looks like.
        .send({ currentPassword: player.password, newPassword: 'AdminOwn3d!Pass' })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.FORBIDDEN_DURING_IMPERSONATION);

      // The old password still works, so nothing was written.
      await login(player.email, player.password).expect(200);
      await login(player.email, 'AdminOwn3d!Pass').expect(401);
    });

    it('a real session can still change its own password', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'self@example.com' });
      const session = await login(player.email, player.password).expect(200);

      await request(app.getHttpServer())
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .send({ currentPassword: player.password, newPassword: 'MyOwnN3w!Pass' })
        .expect(200);

      await login(player.email, 'MyOwnN3w!Pass').expect(200);
    });

    it('caps the impersonation refresh token at the session, not seven days', async () => {
      const admin = await adminToken();
      const player = await ctx.registerVerifiedPlayer({ email: 'capped@example.com' });

      const started = await request(app.getHttpServer())
        .post(`/api/v1/users/${player.userId}/impersonate`)
        .set('Authorization', `Bearer ${admin}`)
        .send({})
        .expect(200);

      const sessionExpiry = new Date(started.body.sessionExpiresAt as string);
      const row = await ctx.dataSource
        .getRepository(RefreshToken)
        .findOne({ where: { userId: player.userId }, order: { expiresAt: 'DESC' } });

      expect(row).not.toBeNull();
      expect((row as RefreshToken).expiresAt.getTime()).toBe(sessionExpiry.getTime());
    });

    it('rejects a non-UUID target id at the pipe, not at the database', async () => {
      const admin = await adminToken();
      const res = await request(app.getHttpServer())
        .post('/api/v1/users/not-a-uuid/impersonate')
        .set('Authorization', `Bearer ${admin}`)
        .send({})
        .expect(400);

      // Without the pipe this is still a 400 — Postgres raises 22P02 and the
      // exception filter maps it — so asserting the status alone would pass
      // either way. The message is what tells the two paths apart.
      expect(String(res.body.message)).toMatch(/uuid/i);
    });
  });

  describe('argon2 parameter upgrades', () => {
    it('rehashes a weakly-hashed password on login without signing other devices out', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'rehash@example.com' });
      const users = ctx.dataSource.getRepository(User);

      // Simulate a hash written under older, cheaper parameters. timeCost has
      // a floor of 2 in argon2, so the memory cost is what differs here.
      const weak = await ctx.passwords.hashWith(player.password, {
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });
      await users.update({ id: player.userId }, { passwordHash: weak });
      const before = (await users.findOne({
        where: { id: player.userId },
        select: { id: true, tokenVersion: true },
      })) as User;

      await login(player.email, player.password).expect(200);

      const after = (await users
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.id = :id', { id: player.userId })
        .getOne()) as User;

      expect(after.passwordHash).not.toBe(weak);
      expect(ctx.passwords.needsRehash(after.passwordHash as string)).toBe(false);
      // A cost upgrade is not a credential change: other devices stay signed in.
      expect(after.tokenVersion).toBe(before.tokenVersion);

      await login(player.email, player.password).expect(200);
    });
  });
});
