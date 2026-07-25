import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { IMPERSONATION_TTL_MS } from '../src/modules/impersonation/impersonation.service';
import { User } from '../src/modules/users/entities/user.entity';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Access tokens live for 15 minutes. Every one of these cases used to leave the
 * already-issued access token fully usable until it expired on its own, because
 * JwtStrategy never consulted the session or user rows.
 */
describe('Access token revocation is immediate (e2e)', () => {
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

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const adminLogin = async (): Promise<{ token: string; id: string }> => {
    const sa = await ctx.seedSuperAdmin();
    const token = await login(sa.email, sa.password);
    const admin = await ctx.dataSource.getRepository(User).findOne({ where: { email: sa.email } });
    return { token, id: (admin as User).id };
  };

  const me = (token: string): request.Test =>
    request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

  it('rejects the access token immediately after logout', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const accessToken = res.body.accessToken as string;

    await me(accessToken).expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: res.body.refreshToken as string })
      .expect(204);

    await me(accessToken)
      .expect(401)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SESSION_REVOKED));
  });

  it('rejects the access token immediately after Super Admin deactivation', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();
    const accessToken = await login(player.email, player.password);

    await me(accessToken).expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/deactivate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    await me(accessToken).expect(401);
  });

  it('rejects the access token immediately after GDPR deletion', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();
    const accessToken = await login(player.email, player.password);

    await me(accessToken).expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${player.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'gdpr request' })
      .expect(200);

    // Deletion revokes the session as well as anonymising the user, so the
    // session check is what fires first here; the ACCOUNT_DELETED path is
    // covered by the SessionValidatorService unit tests.
    await me(accessToken)
      .expect(401)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SESSION_REVOKED));
  });

  it('rejects the impersonation token immediately after Exit Impersonation', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const started = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'support ticket 42' })
      .expect(200);
    const impersonationToken = started.body.accessToken as string;

    await me(impersonationToken).expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/users/impersonation/exit')
      .set('Authorization', `Bearer ${impersonationToken}`)
      .expect(200);

    await me(impersonationToken)
      .expect(401)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SESSION_REVOKED));

    // The admin's own session is untouched by the exit.
    await me(admin.token).expect(200);
  });

  it('enforces the one-hour impersonation cap on the access path', async () => {
    const admin = await adminLogin();
    const player = await ctx.registerVerifiedPlayer();

    const started = await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/impersonate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const impersonationToken = started.body.accessToken as string;

    await me(impersonationToken).expect(200);

    ctx.clock.advance(IMPERSONATION_TTL_MS + 1000);

    await me(impersonationToken)
      .expect(401)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SESSION_EXPIRED));
  });

  it('rejects tokens issued before a password reset', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const accessToken = await login(player.email, player.password);

    await me(accessToken).expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: player.email })
      .expect(202);

    const lastCall =
      ctx.mailer.sendPasswordReset.mock.calls[ctx.mailer.sendPasswordReset.mock.calls.length - 1];
    const resetUrl: string = lastCall[0].resetUrl;
    const token: string = new URL(resetUrl).searchParams.get('token') ?? '';

    await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'An0ther!Str0ngPass' })
      .expect(200);

    await me(accessToken).expect(401);
  });
});
