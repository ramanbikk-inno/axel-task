import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';

describe('Health (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /api/v1/health -> 200 { status: "ok" }', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'ok' }));
  });
});
