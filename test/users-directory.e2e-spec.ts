import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';

describe('Users directory + creation audit log (e2e)', () => {
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

  const createTrainer = async (
    token: string,
    email: string,
    businessName: string,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, businessName, firstName: 'Biz', lastName: 'Owner' })
      .expect(201);
  };

  it('records an audit log row (who/when/details) when a trainer is created', async () => {
    const token = await adminLogin();
    await createTrainer(token, 'audit.trainer@example.com', 'Audited Academy');

    const admin = await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { email: ctx.superAdminEmail } });
    const logs = await ctx.dataSource.getRepository(AuditLog).find();

    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('trainer.created');
    expect(logs[0].actorUserId).toBe((admin as User).id);
    expect(logs[0].targetUserId).toBeTruthy();
    expect(logs[0].metadata).toMatchObject({
      email: 'audit.trainer@example.com',
      businessName: 'Audited Academy',
      role: Role.Trainer,
    });
  });

  it('lists users with pagination for a Super Admin', async () => {
    const token = await adminLogin();
    await createTrainer(token, 't1@example.com', 'Org One');
    await createTrainer(token, 't2@example.com', 'Org Two');

    const res = await request(app.getHttpServer())
      .get('/api/v1/users?page=1&limit=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.total).toBe(3); // super admin + 2 trainers
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('passwordHash');
  });

  it('filters by role and by search substring', async () => {
    const token = await adminLogin();
    await createTrainer(token, 'alice.coach@example.com', 'Alice Academy');
    await createTrainer(token, 'bob.coach@example.com', 'Bob Academy');

    const byRole = await request(app.getHttpServer())
      .get(`/api/v1/users?role=${Role.Trainer}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byRole.body.total).toBe(2);
    expect(byRole.body.items.every((u: { role: Role }) => u.role === Role.Trainer)).toBe(true);

    const bySearch = await request(app.getHttpServer())
      .get('/api/v1/users?search=alice')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bySearch.body.total).toBe(1);
    expect(bySearch.body.items[0].email).toBe('alice.coach@example.com');

    const byStatus = await request(app.getHttpServer())
      .get(`/api/v1/users?status=${UserStatus.Active}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byStatus.body.total).toBe(3);
  });

  it('rejects a non-SuperAdmin caller with 403', async () => {
    const player = await ctx.registerVerifiedPlayer();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${res.body.accessToken as string}`)
      .expect(403);
  });

  /** The read that pairs with the four role-profile PATCH routes. */
  describe('GET /users/:id', () => {
    it('returns a trainer with their organisation profile', async () => {
      const token = await adminLogin();
      await createTrainer(token, 'detail.trainer@example.com', 'Detail Academy');
      const target = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: 'detail.trainer@example.com' } })) as User;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${target.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.user.email).toBe('detail.trainer@example.com');
      expect(res.body.user.role).toBe(Role.Trainer);
      expect(res.body.trainer.businessName).toBe('Detail Academy');
      expect(res.body.player).toBeNull();
      expect(res.body.coach).toBeNull();
    });

    it('returns a player with their trainee profile, and never a password hash', async () => {
      const token = await adminLogin();
      const player = await ctx.registerVerifiedPlayer({ email: 'detail.player@example.com' });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${player.userId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.user.role).toBe(Role.PlayerParent);
      expect(res.body.player).not.toBeNull();
      expect(res.body.player.isChild).toBe(false);
      expect(res.body.trainer).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('argon2');
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('404s on an unknown user and 400s on a non-UUID', async () => {
      const token = await adminLogin();

      await request(app.getHttpServer())
        .get('/api/v1/users/2c9f4b1e-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      await request(app.getHttpServer())
        .get('/api/v1/users/not-a-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('rejects a non-SuperAdmin caller with 403', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'detail.nosy@example.com' });
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: player.email, password: player.password })
        .expect(200);

      await request(app.getHttpServer())
        .get(`/api/v1/users/${player.userId}`)
        .set('Authorization', `Bearer ${res.body.accessToken as string}`)
        .expect(403);
    });

    // `:id` is one segment, so it cannot match these two-segment paths. Pinned anyway.
    it('does not swallow the sibling impersonation routes', async () => {
      const token = await adminLogin();

      await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/users/impersonation/context')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });
});
