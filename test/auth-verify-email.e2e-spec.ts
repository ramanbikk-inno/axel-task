import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';

describe('Email verification (e2e)', () => {
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

  it('register (201 {message}) -> verify-email with the spied token -> login succeeds', async () => {
    const email = 'verify-flow@example.com';
    const password = 'Str0ng!Passw0rd';

    const registerRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    expect(registerRes.body).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });

    const blocked = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(403);
    expect(blocked.body.errorCode).toBe('EMAIL_NOT_VERIFIED');

    expect(ctx.mailer.sendVerification).toHaveBeenCalledTimes(1);
    const verifyUrl: string = ctx.mailer.sendVerification.mock.calls[0][0].verifyUrl;
    const token = new URL(verifyUrl).searchParams.get('token');
    expect(token).toBeTruthy();

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);

    const loginRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(typeof loginRes.body.accessToken).toBe('string');
    expect(ctx.mailer.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('duplicate register returns 201 {message} and does NOT send a second verification email (no leak)', async () => {
    const email = 'dup@example.com';
    const password = 'Str0ng!Passw0rd';

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);
    expect(ctx.mailer.sendVerification).toHaveBeenCalledTimes(1);

    const second = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);
    expect(second.body).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
    expect(ctx.mailer.sendVerification).toHaveBeenCalledTimes(1);
  });

  it('reusing a verification token returns 409 TOKEN_ALREADY_USED', async () => {
    const email = 'reuse-evt@example.com';
    const password = 'Str0ng!Passw0rd';

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    const verifyUrl: string = ctx.mailer.sendVerification.mock.calls[0][0].verifyUrl;
    const token = new URL(verifyUrl).searchParams.get('token');

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);

    const reused = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(409);
    expect(reused.body.errorCode).toBe('TOKEN_ALREADY_USED');
  });

  it('an expired verification token returns 410 EXPIRED_TOKEN (advance the fake clock 25h)', async () => {
    const email = 'expired-evt@example.com';
    const password = 'Str0ng!Passw0rd';

    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    const verifyUrl: string = ctx.mailer.sendVerification.mock.calls[0][0].verifyUrl;
    const token = new URL(verifyUrl).searchParams.get('token');

    ctx.clock.advance(25 * 60 * 60 * 1000);

    const expired = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(410);
    expect(expired.body.errorCode).toBe('EXPIRED_TOKEN');
  });

  it('resend-verification always returns 202', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/resend-verification')
      .send({ email: 'nobody@example.com' })
      .expect(202);
  });
});
