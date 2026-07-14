import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Super Admin deactivate / reactivate (e2e, US-01.12)', () => {
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

  it('deactivates a user: status Inactive, login blocked, refresh revoked, audit logged', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const playerRefresh = login.body.refreshToken as string;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'abuse report' })
      .expect(200);
    expect(res.body.status).toBe(UserStatus.Inactive);

    // Login now blocked with ACCOUNT_INACTIVE.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_INACTIVE));

    // Existing session's refresh token is revoked.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: playerRefresh })
      .expect(401);

    // History preserved: the user row still exists.
    const stillThere = await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: player.userId } });
    expect(stillThere).not.toBeNull();

    // Audit logged.
    const logs = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'user.deactivated' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorUserId).toBe(admin.id);
    expect(logs[0].targetUserId).toBe(player.userId);
  });

  it('reactivates a deactivated user: status Active, login works again', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/reactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(res.body.status).toBe(UserStatus.Active);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    const logs = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'user.reactivated' } });
    expect(logs).toHaveLength(1);
  });

  it('refuses to deactivate a Super Admin account', async () => {
    const admin = await adminLogin();

    await request(app.getHttpServer())
      .post(`/api/v1/users/${admin.id}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CANNOT_DEACTIVATE_SUPER_ADMIN));
  });

  it('refuses to reactivate a deleted (anonymized) user', async () => {
    const admin = await adminLogin();
    const deleted = await createUser(ctx.dataSource, {
      role: Role.PlayerParent,
      status: UserStatus.Deleted,
      email: 'gone@example.com',
    });

    await request(app.getHttpServer())
      .post(`/api/v1/users/${deleted.id}/reactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_DELETED));
  });

  it('returns 404 for an unknown user id', async () => {
    const admin = await adminLogin();

    await request(app.getHttpServer())
      .post(`/api/v1/users/00000000-0000-0000-0000-000000000000/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('rejects a non-SuperAdmin caller with 403', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const target = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/users/${target.userId}/deactivate`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(403);
  });
});
