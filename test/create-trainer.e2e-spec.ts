import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { ErrorCode } from '../src/shared/errors/error-codes';
import { Role } from '../src/modules/users/entities/user.enums';

describe('Create Trainer + setup-password (e2e)', () => {
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

  const adminLogin = async (): Promise<string> => {
    const sa = await ctx.seedSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: sa.email, password: sa.password })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('SuperAdmin creates a trainer; invite setup token lets the trainer set a password and log in', async () => {
    const token = await adminLogin();
    const trainerEmail = 'coach.biz@example.com';

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: trainerEmail,
        firstName: 'Tess',
        lastName: 'Trainer',
        businessName: 'Tess Hoops Academy',
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.email).toBe(trainerEmail);
        expect(res.body.role).toBe(Role.Trainer);
      });

    const inviteCall = ctx.mailer.sendTrainerInvite.mock.calls[0][0];
    expect(inviteCall.to).toBe(trainerEmail);
    const setupToken = new URL(inviteCall.setupUrl).searchParams.get('token') as string;
    expect(setupToken).toBeTruthy();

    const newPassword = 'Tr@inerPass123';
    const setupRes = await request(app.getHttpServer())
      .post('/api/v1/auth/setup-password')
      .send({ token: setupToken, newPassword })
      .expect(200);
    expect(setupRes.body.accessToken).toBeTruthy();
    expect(setupRes.body.refreshToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: trainerEmail, password: newPassword })
      .expect(200);
  });

  it('returns 409 EMAIL_ALREADY_EXISTS on a duplicate trainer email', async () => {
    const token = await adminLogin();
    const body = {
      email: 'dup@example.com',
      businessName: 'Dup Org',
      firstName: 'Dup',
      lastName: 'Trainer',
    };

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409)
      .expect((res) => expect(res.body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS));
  });

  it('returns 403 for a non-SuperAdmin caller', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    const playerToken = res.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ email: 'x@example.com', businessName: 'X', firstName: 'X', lastName: 'Y' })
      .expect(403);
  });

  it('returns 403 CANNOT_CREATE_SUPER_ADMIN when attempting to create a SuperAdmin', async () => {
    const token = await adminLogin();

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'evil@example.com',
        businessName: 'Evil',
        firstName: 'E',
        lastName: 'V',
        role: Role.SuperAdmin,
      })
      .expect(403)
      .expect((res) => expect(res.body.errorCode).toBe(ErrorCode.CANNOT_CREATE_SUPER_ADMIN));
  });
});
