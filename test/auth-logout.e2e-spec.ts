import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('POST /api/v1/auth/logout (e2e)', () => {
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

  async function loginRefreshToken(email: string): Promise<string> {
    await createUser(ctx.dataSource, { email, emailVerified: true });
    const loginRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return loginRes.body.refreshToken as string;
  }

  it('logs out (204) and a subsequent refresh with the same token is rejected (401)', async () => {
    const refreshToken = await loginRefreshToken('logout1@example.com');

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);

    const refreshAfterLogout = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // The refresh row was revoked by logout; presenting it again trips reuse detection.
    expect(refreshAfterLogout.body.errorCode).toBe(ErrorCode.TOKEN_REUSED);
  });

  it('is idempotent: logging out twice with the same token both succeed (204)', async () => {
    const refreshToken = await loginRefreshToken('logout2@example.com');

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);
  });
});
