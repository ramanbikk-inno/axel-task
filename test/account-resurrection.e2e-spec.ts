import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * `markEmailVerified` used to force `status = Active`, so any unconsumed
 * verification or account-setup token was a way back into a deactivated or
 * GDPR-deleted account — in the setup-password case complete with a fresh
 * password and an immediately-issued token pair.
 */
describe('Deactivated and deleted accounts cannot be resurrected (e2e)', () => {
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

  const statusOf = async (userId: string): Promise<UserStatus> => {
    const row = await ctx.dataSource.getRepository(User).findOne({ where: { id: userId } });
    return (row as User).status;
  };

  it('refuses to verify email for a deactivated account, and leaves it Inactive', async () => {
    const adminToken = await adminLogin();

    const email = 'pending@example.com';
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Str0ng!Passw0rd',
        firstName: 'Pen',
        lastName: 'Ding',
        birthDate: '1994-03-22',
      })
      .expect(201);

    const verifyUrl: string = ctx.mailer.sendVerification.mock.calls[0][0].verifyUrl;
    const token: string = new URL(verifyUrl).searchParams.get('token') as string;

    const user = await ctx.dataSource.getRepository(User).findOne({ where: { email } });
    const userId = (user as User).id;

    await request(app.getHttpServer())
      .post(`/api/v1/users/${userId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_INACTIVE));

    expect(await statusOf(userId)).toBe(UserStatus.Inactive);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Str0ng!Passw0rd' })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_INACTIVE));
  });

  it('refuses account setup for a GDPR-deleted invitee, so the account cannot be taken over', async () => {
    const adminToken = await adminLogin();

    const trainerEmail = 'invited@example.com';
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: trainerEmail,
        businessName: 'Invited Org',
        firstName: 'Inv',
        lastName: 'Ited',
      })
      .expect(201);
    const trainerId = created.body.id as string;

    const setupUrl: string = ctx.mailer.sendTrainerInvite.mock.calls[0][0].setupUrl;
    const setupToken: string = new URL(setupUrl).searchParams.get('token') as string;

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${trainerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'gdpr request' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/setup-password')
      .send({ token: setupToken, newPassword: 'Att@ckerPass123' })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_DELETED));

    expect(await statusOf(trainerId)).toBe(UserStatus.Deleted);
  });

  it('refuses to deactivate a deleted user, closing the Deleted→Inactive→Active walk-back', async () => {
    const adminToken = await adminLogin();
    const deleted = await createUser(ctx.dataSource, {
      role: Role.PlayerParent,
      status: UserStatus.Deleted,
      email: 'already-gone@example.com',
    });

    await request(app.getHttpServer())
      .post(`/api/v1/users/${deleted.id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_DELETED));

    await request(app.getHttpServer())
      .post(`/api/v1/users/${deleted.id}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    expect(await statusOf(deleted.id)).toBe(UserStatus.Deleted);
  });

  it('does not mint or mail a fresh verification token for a deactivated account', async () => {
    const adminToken = await adminLogin();

    const email = 'resend@example.com';
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Str0ng!Passw0rd', birthDate: '1994-03-22', firstName: 'Reg' })
      .expect(201);

    const user = await ctx.dataSource.getRepository(User).findOne({ where: { email } });
    await request(app.getHttpServer())
      .post(`/api/v1/users/${(user as User).id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    ctx.mailer.sendVerification.mockClear();

    // Still a 202 so the endpoint stays enumeration-safe.
    await request(app.getHttpServer())
      .post('/api/v1/auth/resend-verification')
      .send({ email })
      .expect(202);

    expect(ctx.mailer.sendVerification).not.toHaveBeenCalled();
  });

  it('does not send a password-reset email to a deleted account', async () => {
    const deleted = await createUser(ctx.dataSource, {
      status: UserStatus.Deleted,
      email: 'gone-reset@example.com',
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: deleted.email })
      .expect(202);

    expect(ctx.mailer.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('still verifies email normally for a healthy account', async () => {
    const email = 'healthy@example.com';
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Str0ng!Passw0rd', birthDate: '1994-03-22', firstName: 'Reg' })
      .expect(201);

    const verifyUrl: string = ctx.mailer.sendVerification.mock.calls[0][0].verifyUrl;
    const token: string = new URL(verifyUrl).searchParams.get('token') as string;

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);

    const user = await ctx.dataSource.getRepository(User).findOne({ where: { email } });
    expect((user as User).emailVerified).toBe(true);
    expect((user as User).status).toBe(UserStatus.Active);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Str0ng!Passw0rd' })
      .expect(200);
  });
});
