import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';

describe('Password reset & change (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
  }, 180000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('forgot-password -> reset-password revokes the session (old refresh token rejected) and the new password logs in', async () => {
    const player = await ctx.registerVerifiedPlayer();

    const loginRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const oldRefreshToken: string = loginRes.body.refreshToken;

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: player.email })
      .expect(202);

    expect(ctx.mailer.sendPasswordReset).toHaveBeenCalledTimes(1);
    const resetUrl: string = ctx.mailer.sendPasswordReset.mock.calls[0][0].resetUrl;
    const token = new URL(resetUrl).searchParams.get('token');
    expect(token).toBeTruthy();

    const newPassword = 'BrandNew!Pass1';
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword })
      .expect(200);

    // §0.9: the access guard is stateless (old access token survives until its TTL),
    // but reset revokes the session, so the old refresh token can no longer rotate.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefreshToken })
      .expect(401);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: newPassword })
      .expect(200);

    expect(ctx.mailer.sendPasswordChanged).toHaveBeenCalledTimes(1);
  });

  it('an expired reset token returns 410 EXPIRED_TOKEN (advance the fake clock 2h)', async () => {
    const player = await ctx.registerVerifiedPlayer();

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: player.email })
      .expect(202);

    const resetUrl: string = ctx.mailer.sendPasswordReset.mock.calls[0][0].resetUrl;
    const token = new URL(resetUrl).searchParams.get('token');

    ctx.clock.advance(2 * 60 * 60 * 1000);

    const expired = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'BrandNew!Pass1' })
      .expect(410);
    expect(expired.body.errorCode).toBe('EXPIRED_TOKEN');
  });

  it('forgot-password always returns 202 for an unknown email', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
      .expect(202);
  });

  it('change-password (JWT): wrong current -> 401; correct -> 200 and the new password logs in', async () => {
    const player = await ctx.registerVerifiedPlayer();

    const loginRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const accessToken: string = loginRes.body.accessToken;

    const wrong = await request(ctx.app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'TotallyWrong!1', newPassword: 'Changed!Pass12' })
      .expect(401);
    expect(wrong.body.errorCode).toBe('INVALID_CREDENTIALS');

    await request(ctx.app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: player.password, newPassword: 'Changed!Pass12' })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: 'Changed!Pass12' })
      .expect(200);
  });

  it('change-password without a JWT -> 401', async () => {
    await request(ctx.app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .send({ currentPassword: 'whatever', newPassword: 'Changed!Pass12' })
      .expect(401);
  });
});
