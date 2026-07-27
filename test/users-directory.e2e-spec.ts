import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { CoachProfile, CoachStatus } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
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

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** A coach employed by their own throwaway trainer org. */
  const seedCoach = async (
    email: string,
    businessName: string,
  ): Promise<{ coachUserId: string; coachProfileId: string }> => {
    const owner = await createUser(ctx.dataSource, {
      role: Role.Trainer,
      email: `org-${email}`,
    });
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const org = await trainers.save(trainers.create({ userId: owner.id, businessName }));

    const coachUser = await createUser(ctx.dataSource, { role: Role.Coach, email });
    const coaches = ctx.dataSource.getRepository(CoachProfile);
    const profile = await coaches.save(
      coaches.create({
        userId: coachUser.id,
        trainerProfileId: org.id,
        joinedAt: new Date(),
        publicVisible: true,
      }),
    );
    return { coachUserId: coachUser.id, coachProfileId: profile.id };
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

    it('returns a coach with their active engagement', async () => {
      const token = await adminLogin();
      const { coachUserId } = await seedCoach('detail.coach@example.com', 'Detail Org');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${coachUserId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.user.role).toBe(Role.Coach);
      expect(res.body.coach).not.toBeNull();
      expect(res.body.coach.userId).toBe(coachUserId);
      expect(res.body.coach.status).toBe(CoachStatus.Active);
      expect(res.body.trainer).toBeNull();
      expect(res.body.player).toBeNull();
    });

    // The row survives off-boarding, but it is no longer a current engagement.
    it('reports an off-boarded coach as having no active profile', async () => {
      const token = await adminLogin();
      const { coachUserId, coachProfileId } = await seedCoach(
        'detail.exco@example.com',
        'Exit Org',
      );
      await ctx.dataSource
        .getRepository(CoachProfile)
        .update({ id: coachProfileId }, { status: CoachStatus.Inactive, endedAt: new Date() });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${coachUserId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.user.role).toBe(Role.Coach);
      expect(res.body.coach).toBeNull();
    });

    // A child's profile is owned by their parent, so the owner lookup misses it.
    it("returns a child login's profile, which their parent owns", async () => {
      const token = await adminLogin();
      const parent = await ctx.registerVerifiedPlayer({ email: 'detail.parent@example.com' });
      const parentToken = await login(parent.email, parent.password);

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(`Authorization`, `Bearer ${parentToken}`)
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'male' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${child.body.id}/login`)
        .set('Authorization', `Bearer ${parentToken}`)
        .send({ email: 'detail.kid@example.com', password: 'K1dSafe!Passw0rd' })
        .expect(201);

      const childUser = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: 'detail.kid@example.com' } })) as User;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${childUser.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.player).not.toBeNull();
      expect(res.body.player.id).toBe(child.body.id);
      expect(res.body.player.isChild).toBe(true);
      expect(res.body.player.ownerUserId).toBe(parent.userId);
    });

    it('returns a Super Admin with no role-specific profile at all', async () => {
      const token = await adminLogin();
      const admin = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: ctx.superAdminEmail } })) as User;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/users/${admin.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.user.role).toBe(Role.SuperAdmin);
      expect(res.body.trainer).toBeNull();
      expect(res.body.player).toBeNull();
      expect(res.body.coach).toBeNull();
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
