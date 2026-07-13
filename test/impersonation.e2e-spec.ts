import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { ImpersonationLog } from '../src/modules/impersonation/entities/impersonation-log.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Super Admin impersonation (e2e, US-01.07)', () => {
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

  const adminLogin = async (): Promise<{ token: string; id: string }> => {
    const sa = await ctx.seedSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: sa.email, password: sa.password })
      .expect(200);
    const admin = await ctx.dataSource.getRepository(User).findOne({ where: { email: sa.email } });
    return { token: res.body.accessToken as string, id: (admin as User).id };
  };

  it('starts impersonation, exposes banner + impersonating principal, then exits and logs duration', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const start = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'support ticket #42' })
      .expect(200);

    expect(start.body.accessToken).toBeTruthy();
    expect(start.body.banner.impersonatedUserId).toBe(player.userId);
    expect(start.body.banner.role).toBe(Role.PlayerParent);
    const impToken = start.body.accessToken as string;

    // The impersonation principal is the target, flagged as impersonating.
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);
    expect(me.body.userId).toBe(player.userId);
    expect(me.body.impersonating).toBe(true);
    expect(me.body.actor.userId).toBe(admin.id);

    // Banner endpoint returns target + admin context.
    const banner = await request(app.getHttpServer())
      .get('/api/v1/users/impersonation/context')
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);
    expect(banner.body.impersonating).toBe(true);
    expect(banner.body.adminUserId).toBe(admin.id);
    expect(banner.body.target.impersonatedUserId).toBe(player.userId);

    // A log row exists, open (no end yet).
    let logs = await ctx.dataSource.getRepository(ImpersonationLog).find();
    expect(logs).toHaveLength(1);
    expect(logs[0].adminUserId).toBe(admin.id);
    expect(logs[0].targetUserId).toBe(player.userId);
    expect(logs[0].endedAt).toBeNull();
    expect(logs[0].reason).toBe('support ticket #42');

    // Exit after 5 minutes -> log closed with duration.
    ctx.clock.advance(5 * 60 * 1000);
    await request(app.getHttpServer())
      .post('/api/v1/users/impersonation/exit')
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);

    logs = await ctx.dataSource.getRepository(ImpersonationLog).find();
    expect(logs[0].endedAt).not.toBeNull();
    expect(logs[0].durationSeconds).toBe(300);
  });

  it('exiting revokes the impersonation session (its refresh token stops working)', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const start = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const refreshToken = start.body.refreshToken as string;
    const impToken = start.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/users/impersonation/exit')
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('refreshing within the hour keeps the impersonation context', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const start = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    ctx.clock.advance(10 * 60 * 1000);
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: start.body.refreshToken as string })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken as string}`)
      .expect(200);
    expect(me.body.impersonating).toBe(true);
    expect(me.body.actor.userId).toBe(admin.id);
  });

  it('enforces the 1-hour session cap on refresh', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const start = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    ctx.clock.advance(61 * 60 * 1000);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: start.body.refreshToken as string })
      .expect(401);
  });

  it('cannot impersonate another Super Admin, nor yourself', async () => {
    const admin = await adminLogin();
    const otherAdmin = await createUser(ctx.dataSource, {
      role: Role.SuperAdmin,
      email: 'admin2@example.com',
    });

    await request(app.getHttpServer())
      .post(`/api/v1/users/${otherAdmin.id}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403)
      .expect((res) => expect(res.body.errorCode).toBe(ErrorCode.CANNOT_IMPERSONATE));

    await request(app.getHttpServer())
      .post(`/api/v1/users/${admin.id}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403)
      .expect((res) => expect(res.body.errorCode).toBe(ErrorCode.CANNOT_IMPERSONATE));
  });

  it('rejects impersonation attempts by non-SuperAdmins', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const target = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/users/${target.userId}/impersonate`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(403);
  });
});
