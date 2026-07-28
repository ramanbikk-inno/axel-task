import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Auth refresh rotation + reuse detection (e2e)', () => {
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

  async function loginTokens(): Promise<{ accessToken: string; refreshToken: string }> {
    await createUser(ctx.dataSource, { email: 'refresh@example.com', emailVerified: true });
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'refresh@example.com', password: FACTORY_PASSWORD })
      .expect(200);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  it('happy rotation issues a new pair and revokes the old refresh token', async () => {
    const first = await loginTokens();

    const rotated = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);

    expect(rotated.body.refreshToken).toEqual(expect.any(String));
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
  });

  it('replaying a rotated (old) refresh token revokes the whole family → new token also rejected', async () => {
    const first = await loginTokens();

    const rotated = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const second = rotated.body.refreshToken as string;

    const reuse = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expect(reuse.body.errorCode).toBe(ErrorCode.TOKEN_REUSED);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second })
      .expect(401);

    // Reuse kills the session, not just the refresh-token family — otherwise an
    // access token already minted from the legitimate rotation stays usable
    // for the rest of its 15-minute life even though the session is compromised.
    await request(ctx.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(401);
  });

  it('rejects a refresh once the session has been idle past the 24h default', async () => {
    const first = await loginTokens();

    ctx.clock.advance(24 * 60 * 60 * 1000 + 1000);
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
  });

  it('allows a refresh made just inside the 24h idle window', async () => {
    const first = await loginTokens();

    ctx.clock.advance(23 * 60 * 60 * 1000);
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
  });
});
