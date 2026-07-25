import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Super Admin GDPR delete (e2e, US-01.13)', () => {
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

  it('anonymizes PII, disables login, preserves history, and writes a compliance audit log', async () => {
    const token = await adminLogin();
    const player = await ctx.registerVerifiedPlayer({ email: 'gone@example.com' });
    // Give the player a self profile + a child (owned profiles with PII).
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me/player')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ displayName: 'Real Name', school: 'Central High' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/users/${player.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'gdpr request #7' })
      .expect(200);
    expect(res.body.status).toBe(UserStatus.Deleted);

    // User PII anonymized.
    const user = await ctx.dataSource.getRepository(User).findOne({ where: { id: player.userId } });
    expect(user?.status).toBe(UserStatus.Deleted);
    expect(user?.firstName).toBe('Deleted');
    expect(user?.lastName).toBe('User');
    expect(user?.email).toBe(`deleted_${player.userId}@example.com`);
    expect(user?.phone).toBeNull();

    // Owned player profiles anonymized (history row preserved, PII stripped).
    const profiles = await ctx.dataSource
      .getRepository(PlayerProfile)
      .find({ where: { ownerUserId: player.userId } });
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      expect(p.displayName).toBe('Deleted User');
      expect(p.school).toBeNull();
    }

    // Login is dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'gone@example.com', password: player.password })
      .expect(401);

    // Compliance record retains the original email/name.
    const logs = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'user.deleted' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({
      originalEmail: 'gone@example.com',
      reason: 'gdpr request #7',
    });
  });

  it('cannot be reactivated after deletion (permanent)', async () => {
    const token = await adminLogin();
    const player = await ctx.registerVerifiedPlayer({ email: 'perm@example.com' });

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${player.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'GDPR erasure request.' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/users/${player.userId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_DELETED));

    // Deleting again is rejected (already deleted).
    await request(app.getHttpServer())
      .delete(`/api/v1/users/${player.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'GDPR erasure request.' })
      .expect(409)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.ACCOUNT_DELETED));
  });

  it('refuses to delete a Super Admin account', async () => {
    const token = await adminLogin();
    const other = await createUser(ctx.dataSource, {
      role: Role.SuperAdmin,
      email: 'admin2@example.com',
    });

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${other.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'GDPR erasure request.' })
      .expect(403)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CANNOT_DELETE_SUPER_ADMIN));
  });

  it('rejects a non-Super-Admin caller', async () => {
    const trainer = await createUser(ctx.dataSource, {
      role: Role.Trainer,
      email: 'tr@example.com',
    });
    await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(
        ctx.dataSource
          .getRepository(TrainerProfile)
          .create({ userId: trainer.id, businessName: 'T' }),
      );
    const target = await ctx.registerVerifiedPlayer({ email: 'victim@example.com' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'tr@example.com', password: FACTORY_PASSWORD })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${target.userId}`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ reason: 'GDPR erasure request.' })
      .expect(403);
  });
});
