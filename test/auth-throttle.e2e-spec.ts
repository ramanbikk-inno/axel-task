import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Auth rate limiting (e2e)', () => {
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

  it('returns 429 RATE_LIMITED with Retry-After on the 6th rapid login within 60s', async () => {
    const body = { email: 'nobody@example.com', password: 'Wr0ng!Passw0rd1' };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send(body);
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app.getHttpServer()).post('/api/v1/auth/login').send(body);

    expect(blocked.status).toBe(429);
    expect(blocked.body.errorCode).toBe(ErrorCode.RATE_LIMITED);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('throttles password spraying across many different accounts from one IP', async () => {
    // Every attempt uses a different address, so the per-account bucket never
    // fills — this used to run unbounded. The per-IP bucket (20/min on login)
    // is what stops it.
    let blocked = 0;
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `victim-${attempt}@example.com`, password: 'C0mmon!Passw0rd' });
      if (res.status === 429) {
        blocked += 1;
      }
    }

    expect(blocked).toBeGreaterThan(0);
  });
});
