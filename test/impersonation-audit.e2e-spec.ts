import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';

/**
 * `actor_user_id` on an audited action is the identity the request was made
 * *as*, which during an impersonation is the target. On its own that makes an
 * admin's actions indistinguishable from the user's own.
 */
describe('Impersonation audit attribution (e2e)', () => {
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

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const adminSession = async (): Promise<{ token: string; id: string }> => {
    const sa = await ctx.seedSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: sa.email, password: sa.password })
      .expect(200);
    const admin = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { email: sa.email } })) as User;
    return { token: res.body.accessToken as string, id: admin.id };
  };

  /** A second Super Admin, so one can be impersonation-audited by the other. */
  const makeVictim = async (): Promise<string> => {
    const users = ctx.dataSource.getRepository(User);
    const victim = await users.save(
      users.create({
        email: 'victim-trainer@example.com',
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
      }),
    );
    return victim.id;
  };

  it('attributes an action taken during impersonation to the admin, not just the target', async () => {
    const admin = await adminSession();
    const victimId = await makeVictim();

    const started = await request(app.getHttpServer())
      .post(`/api/v1/users/${victimId}/impersonate`)
      .set(auth(admin.token))
      .send({ reason: 'support ticket 42' })
      .expect(200);

    // A profile edit is the archetypal thing an admin does while impersonating
    // — and until now it wrote nothing to the audit log at all, so there was
    // no row to attribute.
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set(auth(started.body.accessToken as string))
      .send({ firstName: 'Touched' })
      .expect(200);

    const rows = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'profile.updated' } });

    expect(rows).toHaveLength(1);
    // actorUserId is the identity the request was made *as*; the admin behind
    // it lives in its own column, so a reviewer can ask either question.
    expect(rows[0].actorUserId).toBe(victimId);
    expect(rows[0].onBehalfOfAdminId).toBe(admin.id);
    expect(rows[0].impersonationSessionId).not.toBeNull();
    expect(rows[0].metadata).toMatchObject({ fields: ['firstName'] });
  });

  it('surfaces that action in the impersonation history report', async () => {
    const admin = await adminSession();
    const victimId = await makeVictim();

    const started = await request(app.getHttpServer())
      .post(`/api/v1/users/${victimId}/impersonate`)
      .set(auth(admin.token))
      .send({ reason: 'ticket 44' })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set(auth(started.body.accessToken as string))
      .send({ firstName: 'Touched', lastName: 'Twice' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/users/impersonation/exit')
      .set(auth(started.body.accessToken as string))
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/users/impersonation/history')
      .set(auth(admin.token))
      .expect(200);

    // "an admin was signed in as this user for 40 minutes" answers nothing a
    // compliance reviewer will actually ask; what they did is the point.
    expect(res.body.items[0].actions).toHaveLength(1);
    expect(res.body.items[0].actions[0]).toMatchObject({ action: 'profile.updated' });
  });

  it('does not attribute the user’s own edits to any admin', async () => {
    await adminSession();
    const player = await ctx.registerVerifiedPlayer({ email: 'self-edit@example.com' });
    const session = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set(auth(session.body.accessToken as string))
      .send({ firstName: 'Mine' })
      .expect(200);

    const rows = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'profile.updated' } });

    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(player.userId);
    expect(rows[0].onBehalfOfAdminId).toBeNull();
    expect(rows[0].impersonationSessionId).toBeNull();
  });

  it('records an ordinary admin action with no impersonation columns', async () => {
    const admin = await adminSession();

    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(auth(admin.token))
      .send({
        email: 'plain-trainer@example.com',
        businessName: 'Plain Org',
        firstName: 'P',
        lastName: 'T',
      })
      .expect(201);

    const row = (await ctx.dataSource
      .getRepository(AuditLog)
      .findOne({ where: { targetUserId: created.body.id as string } })) as AuditLog;

    expect(row.actorUserId).toBe(admin.id);
    expect(row.onBehalfOfAdminId).toBeNull();
    expect(row.impersonationSessionId).toBeNull();
  });

  describe('impersonation history report', () => {
    it('lists sessions newest first with duration and reason', async () => {
      const admin = await adminSession();
      const player = await ctx.registerVerifiedPlayer({ email: 'hist@example.com' });

      const started = await request(app.getHttpServer())
        .post(`/api/v1/users/${player.userId}/impersonate`)
        .set(auth(admin.token))
        .send({ reason: 'ticket 99' })
        .expect(200);

      ctx.clock.advance(5 * 60 * 1000);
      await request(app.getHttpServer())
        .post('/api/v1/users/impersonation/exit')
        .set(auth(started.body.accessToken as string))
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .set(auth(admin.token))
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0]).toMatchObject({
        adminUserId: admin.id,
        adminEmail: ctx.superAdminEmail,
        targetUserId: player.userId,
        targetEmail: 'hist@example.com',
        reason: 'ticket 99',
        durationSeconds: 300,
      });
      expect(res.body.items[0].endedAt).not.toBeNull();
    });

    it('shows a session that is still open', async () => {
      const admin = await adminSession();
      const player = await ctx.registerVerifiedPlayer({ email: 'open@example.com' });

      await request(app.getHttpServer())
        .post(`/api/v1/users/${player.userId}/impersonate`)
        .set(auth(admin.token))
        .send({})
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .set(auth(admin.token))
        .expect(200);

      expect(res.body.items[0].endedAt).toBeNull();
      expect(res.body.items[0].durationSeconds).toBeNull();
    });

    it('filters by target user', async () => {
      const admin = await adminSession();
      const a = await ctx.registerVerifiedPlayer({ email: 'a-hist@example.com' });
      const b = await ctx.registerVerifiedPlayer({ email: 'b-hist@example.com' });

      for (const target of [a, b]) {
        const s = await request(app.getHttpServer())
          .post(`/api/v1/users/${target.userId}/impersonate`)
          .set(auth(admin.token))
          .send({})
          .expect(200);
        await request(app.getHttpServer())
          .post('/api/v1/users/impersonation/exit')
          .set(auth(s.body.accessToken as string))
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .query({ targetUserId: b.userId })
        .set(auth(admin.token))
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0].targetUserId).toBe(b.userId);
    });

    it('paginates', async () => {
      const admin = await adminSession();
      for (const n of [1, 2, 3]) {
        const target = await ctx.registerVerifiedPlayer({ email: `p${n}-hist@example.com` });
        const s = await request(app.getHttpServer())
          .post(`/api/v1/users/${target.userId}/impersonate`)
          .set(auth(admin.token))
          .send({})
          .expect(200);
        await request(app.getHttpServer())
          .post('/api/v1/users/impersonation/exit')
          .set(auth(s.body.accessToken as string))
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .query({ page: 2, pageSize: 2 })
        .set(auth(admin.token))
        .expect(200);

      expect(res.body.total).toBe(3);
      expect(res.body.items).toHaveLength(1);
    });

    it('is Super Admin only', async () => {
      await adminSession();
      const player = await ctx.registerVerifiedPlayer({ email: 'nosy@example.com' });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: player.email, password: player.password })
        .expect(200);

      // A compliance report naming every impersonated account is not something
      // an ordinary player should be able to read.
      await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .set(auth(login.body.accessToken as string))
        .expect(403);
    });

    it('rejects a malformed filter', async () => {
      const admin = await adminSession();
      await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .query({ targetUserId: 'not-a-uuid' })
        .set(auth(admin.token))
        .expect(422);
    });
  });
});
