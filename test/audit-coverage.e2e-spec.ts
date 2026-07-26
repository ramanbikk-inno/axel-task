import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';

/**
 * The attribution mechanism was complete, but only admin/, coaches/, profile/
 * and impersonation/ ever emitted a row — so every mutation reachable through
 * availability/, family/, enrollment/ and trainers/ produced no audit entry at
 * all, and therefore no `on_behalf_of_admin_id` and nothing in the
 * impersonation history. These tests pin the emission itself; without them the
 * next refactor can silently drop an action and nothing fails.
 */
describe('Audit coverage for mutating endpoints (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    app = ctx.app;
  }, 180000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/logo.png', publicId: 'logos/x' });
    ctx.storage.delete.mockResolvedValue(undefined);
  });

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const audits = (action: string): Promise<AuditLog[]> =>
    ctx.dataSource.getRepository(AuditLog).find({ where: { action } });

  const oneAudit = async (action: string): Promise<AuditLog> => {
    const rows = await audits(action);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  const makeTrainer = async (
    email: string,
  ): Promise<{ token: string; userId: string; trainerProfileId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName: 'Elite Soccer' }));
    return {
      token: await login(email, FACTORY_PASSWORD),
      userId: user.id,
      trainerProfileId: profile.id,
    };
  };

  const makeParent = async (email: string): Promise<{ token: string; userId: string }> => {
    const parent = await ctx.registerVerifiedPlayer({ email });
    return { token: await login(parent.email, parent.password), userId: parent.userId };
  };

  describe('trainers/ — portal branding', () => {
    it('records the colour change against the trainer org', async () => {
      const trainer = await makeTrainer('brand-color@example.com');

      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(trainer.token))
        .send({ primaryColor: '#1e88e5' })
        .expect(200);

      const row = await oneAudit('trainer.branding-color-set');
      expect(row.actorUserId).toBe(trainer.userId);
      expect(row.targetType).toBe('TrainerOrg');
      expect(row.targetId).toBe(trainer.trainerProfileId);
      expect(row.metadata).toMatchObject({ primaryColor: '#1e88e5' });
    });

    it('records a logo upload and distinguishes a replacement from a first upload', async () => {
      const trainer = await makeTrainer('brand-logo@example.com');
      const upload = (): request.Test =>
        request(app.getHttpServer())
          .post('/api/v1/trainers/me/logo')
          .set(auth(trainer.token))
          .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: PNG });

      await upload().expect(200);
      await upload().expect(200);

      const rows = await audits('trainer.branding-logo-set');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.metadata?.replacedPrevious).sort()).toEqual([false, true]);
    });

    it('records logo removal', async () => {
      const trainer = await makeTrainer('brand-remove@example.com');
      await request(app.getHttpServer())
        .post('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: PNG })
        .expect(200);

      await request(app.getHttpServer())
        .delete('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .expect(200);

      const row = await oneAudit('trainer.branding-logo-removed');
      expect(row.actorUserId).toBe(trainer.userId);
      expect(row.targetId).toBe(trainer.trainerProfileId);
    });

    it('writes nothing when the mutation is rejected', async () => {
      const trainer = await makeTrainer('brand-reject@example.com');

      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(trainer.token))
        .send({ primaryColor: 'not-a-hex' })
        .expect(422);

      expect(await audits('trainer.branding-color-set')).toHaveLength(0);
    });
  });

  describe('family/ — profiles and associations', () => {
    it('records child creation', async () => {
      const parent = await makeParent('audit-child@example.com');

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parent.token))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);

      const row = await oneAudit('family.child-created');
      expect(row.actorUserId).toBe(parent.userId);
      expect(row.targetType).toBe('PlayerProfile');
      expect(row.targetId).toBe(child.body.id);
    });

    it('records a child login being issued and then revoked, naming the child account', async () => {
      const parent = await makeParent('audit-childlogin@example.com');
      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parent.token))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/players/children/${child.body.id as string}/login`)
        .set(auth(parent.token))
        .send({ email: 'audit.kid@example.com', password: 'K1dSafe!Passw0rd' })
        .expect(201);
      const childUserId = created.body.childUserId as string;

      await request(app.getHttpServer())
        .delete(`/api/v1/players/children/${child.body.id as string}/login`)
        .set(auth(parent.token))
        .expect(204);

      const issued = await oneAudit('family.child-login-created');
      expect(issued.actorUserId).toBe(parent.userId);
      expect(issued.targetUserId).toBe(childUserId);

      const revoked = await oneAudit('family.child-login-revoked');
      expect(revoked.actorUserId).toBe(parent.userId);
      expect(revoked.targetUserId).toBe(childUserId);
    });

    it('records adding and removing a trainer, and says which route was used', async () => {
      const trainer = await makeTrainer('audit-assoc-trainer@example.com');
      const parent = await makeParent('audit-assoc-parent@example.com');

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      // Parent joins, which creates their own profile under this trainer.
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(parent.token))
        .send({})
        .expect(200);

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parent.token))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);
      const childProfileId = child.body.id as string;

      await request(app.getHttpServer())
        .post(`/api/v1/players/${childProfileId}/trainers`)
        .set(auth(parent.token))
        .send({ trainerProfileId: trainer.trainerProfileId })
        .expect(200);

      const added = await audits('family.trainer-added');
      expect(added).toHaveLength(1);
      expect(added[0].targetId).toBe(childProfileId);
      expect(added[0].metadata).toMatchObject({
        trainerProfileId: trainer.trainerProfileId,
        via: 'my-trainers',
      });

      await request(app.getHttpServer())
        .delete(`/api/v1/players/${childProfileId}/trainers/${trainer.trainerProfileId}`)
        .set(auth(parent.token))
        .expect(200);

      const removed = await oneAudit('family.trainer-removed');
      expect(removed.targetId).toBe(childProfileId);
      expect(removed.metadata).toMatchObject({ trainerProfileId: trainer.trainerProfileId });
    });

    it('distinguishes a share-link join from picking an existing trainer', async () => {
      const trainer = await makeTrainer('audit-bycode-trainer@example.com');
      const parent = await makeParent('audit-bycode-parent@example.com');

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parent.token))
        .send({ displayName: 'Maya', birthDate: '2015-02-01', gender: 'female' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/players/${child.body.id as string}/trainers/by-code`)
        .set(auth(parent.token))
        .send({ code: link.body.code })
        .expect(200);

      const row = await oneAudit('family.trainer-added');
      expect(row.metadata).toMatchObject({
        trainerProfileId: trainer.trainerProfileId,
        via: 'share-link',
      });
    });
  });

  describe('enrollment/ — links and joins', () => {
    it('records share-link creation against the link itself', async () => {
      const trainer = await makeTrainer('audit-link@example.com');

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      const row = await oneAudit('sharelink.created');
      expect(row.actorUserId).toBe(trainer.userId);
      expect(row.targetType).toBe('ShareLink');
      expect(row.metadata).toMatchObject({ linkType: 'player_static' });
      expect(link.body.code).toBeDefined();
    });

    it('records an existing player joining another trainer', async () => {
      const trainer = await makeTrainer('audit-join-trainer@example.com');
      const parent = await makeParent('audit-join-parent@example.com');

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(parent.token))
        .send({})
        .expect(200);

      const row = await oneAudit('enrollment.joined');
      expect(row.actorUserId).toBe(parent.userId);
      expect(row.targetType).toBe('TrainerOrg');
      expect(row.targetId).toBe(trainer.trainerProfileId);
      expect(row.metadata).toMatchObject({ created: true });
    });

    it('records a public registration as a system action, with no actor', async () => {
      const trainer = await makeTrainer('audit-reg-trainer@example.com');
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}/register`)
        .send({
          birthDate: '1994-03-22',
          email: 'brand-new@example.com',
          password: 'Str0ng!Passw0rd',
          firstName: 'New',
          lastName: 'Player',
        })
        .expect(201);

      const row = await oneAudit('enrollment.registered');
      // The endpoint is public: the account being created is the subject of the
      // action, not its actor, so attributing it to anyone would be a fiction.
      expect(row.actorUserId).toBeNull();
      expect(row.onBehalfOfAdminId).toBeNull();
      expect(row.targetUserId).not.toBeNull();
      expect(row.targetId).toBe(trainer.trainerProfileId);
    });
  });

  describe('availability/ — Best Times and My Times', () => {
    it('records a player availability replacement with the resulting slot count', async () => {
      const trainer = await makeTrainer('audit-avail-trainer@example.com');
      const parent = await makeParent('audit-avail-parent@example.com');
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);
      const joined = await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(parent.token))
        .send({})
        .expect(200);
      const profileId = joined.body.playerProfileId as string;

      await request(app.getHttpServer())
        .put(`/api/v1/players/${profileId}/availability`)
        .set(auth(parent.token))
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '17:00', endTime: '20:00' },
            { dayOfWeek: 3, startTime: '18:00', endTime: '21:00' },
          ],
        })
        .expect(200);

      const row = await oneAudit('availability.player-set');
      expect(row.actorUserId).toBe(parent.userId);
      expect(row.targetType).toBe('PlayerProfile');
      expect(row.targetId).toBe(profileId);
      expect(row.metadata).toMatchObject({ slotCount: 2 });
    });

    it('records a coach setting My Times against the coach profile', async () => {
      const trainer = await makeTrainer('audit-coach-trainer@example.com');
      const coachUser = await createUser(ctx.dataSource, {
        role: Role.Coach,
        email: 'audit-coach@example.com',
      });
      const coaches = ctx.dataSource.getRepository(CoachProfile);
      const coachProfile = await coaches.save(
        coaches.create({
          userId: coachUser.id,
          trainerProfileId: trainer.trainerProfileId,
          joinedAt: new Date(),
        }),
      );
      const coachToken = await login('audit-coach@example.com', FACTORY_PASSWORD);

      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '16:00', endTime: '20:00' }] })
        .expect(200);

      const row = await oneAudit('availability.coach-set');
      expect(row.actorUserId).toBe(coachUser.id);
      expect(row.targetType).toBe('CoachProfile');
      expect(row.targetId).toBe(coachProfile.id);
      expect(row.metadata).toMatchObject({ slotCount: 1 });
    });

    it('records a coach availability override, including whether it really clashed', async () => {
      const trainer = await makeTrainer('audit-override-trainer@example.com');
      const coachUser = await createUser(ctx.dataSource, {
        role: Role.Coach,
        email: 'audit-override-coach@example.com',
      });
      const coaches = ctx.dataSource.getRepository(CoachProfile);
      const coachProfile = await coaches.save(
        coaches.create({
          userId: coachUser.id,
          trainerProfileId: trainer.trainerProfileId,
          joinedAt: new Date(),
        }),
      );

      // No stated availability, so scheduling into it genuinely clashes.
      await request(app.getHttpServer())
        .post('/api/v1/coach-overrides')
        .set(auth(trainer.token))
        .send({
          coachProfileId: coachProfile.id,
          dayOfWeek: 1,
          startTime: '16:00',
          endTime: '18:00',
          overrideReason: 'Only coach certified for this age group.',
        })
        .expect(201);

      const row = await oneAudit('coach.availability-overridden');
      expect(row.actorUserId).toBe(trainer.userId);
      expect(row.targetType).toBe('CoachProfile');
      expect(row.targetId).toBe(coachProfile.id);
      expect(row.metadata).toMatchObject({ hadConflict: true, dayOfWeek: 1 });
    });
  });

  describe('impersonation attribution reaches the newly-audited modules', () => {
    it('stamps the admin on a branding change made while impersonating a trainer', async () => {
      const sa = await ctx.seedSuperAdmin();
      const adminToken = await login(sa.email, sa.password);
      const trainer = await makeTrainer('imp-brand@example.com');

      const started = await request(app.getHttpServer())
        .post(`/api/v1/users/${trainer.userId}/impersonate`)
        .set(auth(adminToken))
        .send({ reason: 'Branding support ticket.' })
        .expect(200);

      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(started.body.accessToken as string))
        .send({ primaryColor: '#ff0000' })
        .expect(200);

      const row = await oneAudit('trainer.branding-color-set');
      // actor stays the identity the request was made as...
      expect(row.actorUserId).toBe(trainer.userId);
      // ...and the admin behind it is recorded separately, which is the whole
      // point of attributing actions to the admin behind them.
      expect(row.onBehalfOfAdminId).not.toBeNull();
      expect(row.impersonationSessionId).not.toBeNull();
    });
  });
});
