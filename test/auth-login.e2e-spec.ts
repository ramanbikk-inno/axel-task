import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { ErrorCode } from '../src/shared/errors/error-codes';
import { UserStatus } from '../src/modules/users/entities/user.enums';

describe('Auth login/register/me (e2e)', () => {
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

  it('POST /auth/register returns 201 with the generic message', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'newplayer@example.com', password: FACTORY_PASSWORD, birthDate: '1994-03-22' })
      .expect(201);

    expect(res.body).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
  });

  it('POST /auth/register on a duplicate email also returns 201 with the same message (no leak)', async () => {
    await createUser(ctx.dataSource, { email: 'dup@example.com' });

    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'dup@example.com', password: FACTORY_PASSWORD, birthDate: '1994-03-22' })
      .expect(201);

    expect(res.body).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
  });

  it('POST /auth/login is blocked with 403 EMAIL_NOT_VERIFIED for an unverified user (no tokens)', async () => {
    await createUser(ctx.dataSource, { email: 'unverified@example.com', emailVerified: false });

    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'unverified@example.com', password: FACTORY_PASSWORD })
      .expect(403);

    expect(res.body.errorCode).toBe(ErrorCode.EMAIL_NOT_VERIFIED);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('POST /auth/login returns 200 + tokens for a verified user', async () => {
    await createUser(ctx.dataSource, {
      email: 'verified@example.com',
      emailVerified: true,
      status: UserStatus.Active,
    });

    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'verified@example.com', password: FACTORY_PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.expiresIn).toEqual(expect.any(Number));
  });

  it('GET /auth/me returns the effective principal for a valid access token', async () => {
    await createUser(ctx.dataSource, { email: 'me@example.com', emailVerified: true });

    const login = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'me@example.com', password: FACTORY_PASSWORD })
      .expect(200);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);

    expect(me.body.role).toBe('PlayerParent');
    expect(me.body.scope).toBe('trainer');
    expect(me.body.impersonating).toBe(false);
    expect(me.body.userId).toEqual(expect.any(String));
  });

  it('GET /auth/me without a token returns 401', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });
});
