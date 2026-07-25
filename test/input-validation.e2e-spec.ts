import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Regression cover for the validation gaps found auditing Epic-01 against the
 * spec. The age cases are the important ones: `@IsISO8601()` accepted a full
 * date-time, `new Date(value + 'T00:00:00.000Z')` then produced Invalid Date,
 * and because every comparison against NaN is false the 1-18 gate passed
 * anything at all — an adult could be stored as a child.
 */
describe('Input validation (e2e)', () => {
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

  const parentToken = async (email: string): Promise<string> => {
    const parent = await ctx.registerVerifiedPlayer({ email });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: parent.password })
      .expect(200);
    return login.body.accessToken as string;
  };

  const adminToken = async (): Promise<string> => {
    await ctx.seedSuperAdmin();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ctx.superAdminEmail, password: ctx.superAdminPassword })
      .expect(200);
    return login.body.accessToken as string;
  };

  const child = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    displayName: 'Maya Smith',
    birthDate: '2014-08-01',
    gender: 'female',
    ...over,
  });

  describe('child birthDate (US-01.03)', () => {
    it('accepts a plain calendar date', async () => {
      const token = await parentToken('p1@example.com');

      const res = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child())
        .expect(201);

      expect(res.body.birthDate).toBe('2014-08-01');
    });

    it.each(['1970-01-01T00:00:00.000Z', '1930-01-01T12:00:00Z', '2014-08-01T00:00', '20140801'])(
      'rejects the date-time form %s instead of storing an adult as a child',
      async (value) => {
        const token = await parentToken(`p-${Buffer.from(value).toString('hex')}@example.com`);

        const res = await request(app.getHttpServer())
          .post('/api/v1/players/children')
          .set('Authorization', `Bearer ${token}`)
          .send(child({ birthDate: value }))
          .expect(422);

        expect(res.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
        expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(0);
      },
    );

    it('rejects a date that looks well-formed but is not a real day', async () => {
      const token = await parentToken('p2@example.com');

      // Date would silently roll 2008-02-30 forward to March 1st.
      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child({ birthDate: '2008-02-30' }))
        .expect(422);
    });

    it('still enforces the 1-18 range for real dates', async () => {
      const token = await parentToken('p3@example.com');

      const tooOld = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child({ birthDate: '1990-01-01' }))
        .expect(400);
      expect(tooOld.body.errorCode).toBe(ErrorCode.CHILD_AGE_INVALID);

      const notYetOne = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child({ birthDate: '2026-06-01' }))
        .expect(400);
      expect(notYetOne.body.errorCode).toBe(ErrorCode.CHILD_AGE_INVALID);
    });

    it('detects a duplicate child regardless of how the date was written', async () => {
      const token = await parentToken('p4@example.com');
      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child())
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set('Authorization', `Bearer ${token}`)
        .send(child())
        .expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.DUPLICATE_CHILD);
    });
  });

  describe('trainer creation (US-01.01)', () => {
    it('requires a trainer name, not just a business name', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'nameless@example.com', businessName: 'Nameless Org' })
        .expect(422);
    });

    it('still rejects role=SuperAdmin with the documented error code', async () => {
      const token = await adminToken();

      const res = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'evil@example.com',
          businessName: 'Evil',
          firstName: 'E',
          lastName: 'V',
          role: 'SuperAdmin',
        })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.CANNOT_CREATE_SUPER_ADMIN);
    });

    it('rejects a role it cannot create instead of quietly making a Trainer', async () => {
      const token = await adminToken();

      const res = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'coachy@example.com',
          businessName: 'Org',
          firstName: 'C',
          lastName: 'O',
          role: 'Coach',
        })
        .expect(400);

      expect(res.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it.each(['not-a-phone', '123', '<script>alert(1)</script>'])(
      'rejects the malformed phone %p',
      async (phone: string) => {
        const token = await adminToken();

        await request(app.getHttpServer())
          .post('/api/v1/users')
          .set('Authorization', `Bearer ${token}`)
          .send({
            email: `phone-${Buffer.from(phone).toString('hex')}@example.com`,
            businessName: 'Org',
            firstName: 'P',
            lastName: 'H',
            phone,
          })
          .expect(422);
      },
    );

    it('accepts a normal international phone number', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'ok-phone@example.com',
          businessName: 'Org',
          firstName: 'P',
          lastName: 'H',
          phone: '+1 (555) 123-4567',
        })
        .expect(201);
    });
  });

  describe('GDPR deletion reason (US-01.13)', () => {
    const makeTrainer = async (token: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'victim@example.com',
          businessName: 'Org',
          firstName: 'V',
          lastName: 'I',
        })
        .expect(201);
      return res.body.id as string;
    };

    it('refuses an irreversible delete with no reason', async () => {
      const token = await adminToken();
      const id = await makeTrainer(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(422);
    });

    it('refuses a whitespace-only reason', async () => {
      const token = await adminToken();
      const id = await makeTrainer(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '     ' })
        .expect(422);
    });

    it('accepts a real reason', async () => {
      const token = await adminToken();
      const id = await makeTrainer(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Account holder exercised right to erasure.' })
        .expect(200);
    });
  });

  describe('profile names', () => {
    it('rejects a blank first name rather than storing an empty one', async () => {
      const token = await parentToken('p5@example.com');

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: '' })
        .expect(422);
    });
  });
});
