import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';

/**
 * Changing your password is the standard remediation after a device is lost or
 * a session is stolen. It used to leave every existing session alive, so the
 * thief simply kept refreshing.
 */
describe('Password change revokes other sessions (e2e)', () => {
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

  const login = async (
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string }> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
    };
  };

  it('kills a second device’s refresh token and returns fresh tokens to the caller', async () => {
    const player = await ctx.registerVerifiedPlayer();

    const thief = await login(player.email, player.password);
    const owner = await login(player.email, player.password);

    // Both sessions are live to begin with.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: thief.refreshToken })
      .expect(200);

    const changed = await request(app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ currentPassword: player.password, newPassword: 'N3w!Passw0rd!x' })
      .expect(200);

    expect(changed.body.message).toBe('Password changed.');
    expect(changed.body.accessToken).toBeTruthy();
    expect(changed.body.refreshToken).toBeTruthy();

    // The other device can no longer refresh.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: thief.refreshToken })
      .expect(401);

    // The caller stays signed in on the tokens they were handed back.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${changed.body.accessToken as string}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: changed.body.refreshToken as string })
      .expect(200);
  });

  it('revokes the session the change was made from as well', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const owner = await login(player.email, player.password);

    await request(app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ currentPassword: player.password, newPassword: 'N3w!Passw0rd!x' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: owner.refreshToken })
      .expect(401);
  });

  it('lets the user log in with the new password and not the old one', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const owner = await login(player.email, player.password);

    await request(app.getHttpServer())
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ currentPassword: player.password, newPassword: 'N3w!Passw0rd!x' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(401);

    await login(player.email, 'N3w!Passw0rd!x');
  });
});
