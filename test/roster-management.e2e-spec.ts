import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { bootstrapE2E, E2EContext } from './setup-e2e';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { AuthSession } from '../src/modules/auth/entities/auth-session.entity';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';

/**
 * The trainer's own side of the roster: recording a skill level and off-boarding
 * a player who has left.
 *
 * Both write against a profile someone else owns, so the interesting cases are
 * the boundaries: who may call them, what happens to a session parked in the
 * context being severed, and whether "removed" means gone or disconnected.
 */
describe('Trainer roster management (e2e)', () => {
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

  const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  interface Org {
    token: string;
    userId: string;
    trainerProfileId: string;
  }

  const makeOrg = async (email: string, businessName = 'Elite Soccer'): Promise<Org> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName }));
    return {
      token: await login(email, FACTORY_PASSWORD),
      userId: user.id,
      trainerProfileId: profile.id,
    };
  };

  const shareLinkCode = async (org: Org): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set(auth(org.token))
      .send({})
      .expect(201);
    return res.body.code as string;
  };

  const join = async (code: string, token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/join/${code}`)
      .set(auth(token))
      .send({})
      .expect(200);
    return res.body.playerProfileId as string;
  };

  interface Enrolled {
    org: Org;
    parentToken: string;
    profileId: string;
  }

  const seed = async (prefix: string): Promise<Enrolled> => {
    const org = await makeOrg(`${prefix}-trainer@example.com`);
    const parent = await ctx.registerVerifiedPlayer({ email: `${prefix}-parent@example.com` });
    const parentToken = await login(parent.email, parent.password);
    const profileId = await join(await shareLinkCode(org), parentToken);
    return { org, parentToken, profileId };
  };

  const roster = async (
    org: Org,
    includeInactive = false,
  ): Promise<Array<Record<string, unknown>>> => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/roster')
      .query(includeInactive ? { includeInactive: true } : {})
      .set(auth(org.token))
      .expect(200);
    return res.body as Array<Record<string, unknown>>;
  };

  describe('recording a skill level', () => {
    it('rejects a value past the column bound at the pipe', async () => {
      const { org, profileId } = await seed('skill-long');

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .send({ skillLevel: 'x'.repeat(61) })
        .expect(422);
    });

    it('accepts a value exactly at the bound', async () => {
      const { org, profileId } = await seed('skill-bound');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .send({ skillLevel: 'x'.repeat(60) })
        .expect(200);
      expect(res.body.skillLevel).toHaveLength(60);
    });

    it('rejects a malformed profile id before reaching the service', async () => {
      const { org } = await seed('skill-badid');

      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/roster/not-a-uuid')
        .set(auth(org.token))
        .send({ skillLevel: 'Intermediate' })
        .expect(400);
    });

    it('reports an id that names nothing as not on the roster', async () => {
      const { org } = await seed('skill-missing');

      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/roster/00000000-0000-4000-8000-000000000000')
        .set(auth(org.token))
        .send({ skillLevel: 'Intermediate' })
        .expect(404);
    });

    it('is not the parent’s to set — it is the trainer’s assessment', async () => {
      const { parentToken, profileId } = await seed('skill-parent');

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(parentToken))
        .send({ skillLevel: 'Elite' })
        .expect(403);
    });

    it('is not a coach’s to set either', async () => {
      const { org, profileId } = await seed('skill-coach');
      const coachUser = await createUser(ctx.dataSource, {
        role: Role.Coach,
        email: 'skill-coach-user@example.com',
      });
      const coaches = ctx.dataSource.getRepository(CoachProfile);
      await coaches.save(
        coaches.create({
          userId: coachUser.id,
          trainerProfileId: org.trainerProfileId,
          joinedAt: new Date(),
        }),
      );
      const coachToken = await login('skill-coach-user@example.com', FACTORY_PASSWORD);

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(coachToken))
        .send({ skillLevel: 'Elite' })
        .expect(403);
    });

    it('records an audit row naming the profile and the organisation', async () => {
      const { org, profileId } = await seed('skill-audit');

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .send({ skillLevel: 'Advanced' })
        .expect(200);

      const rows = await ctx.dataSource
        .getRepository(AuditLog)
        .find({ where: { action: 'roster.skill-level-set' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(org.userId);
      expect(rows[0].targetId).toBe(profileId);
      expect(rows[0].metadata).toMatchObject({
        trainerProfileId: org.trainerProfileId,
        skillLevel: 'Advanced',
      });
    });
  });

  describe('off-boarding a player', () => {
    it('drops a session parked in that context back to no selection', async () => {
      const { org, parentToken, profileId } = await seed('remove-context');

      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(parentToken))
        .send({ playerProfileId: profileId, trainerProfileId: org.trainerProfileId })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      // The mirror of the family-side disconnect: whoever severs the association,
      // a session must not be left naming a trainer it is no longer connected to.
      const live = (await ctx.dataSource.getRepository(AuthSession).find()).filter(
        (s) => s.revokedAt === null && s.activePlayerProfileId === profileId,
      );
      expect(live).toHaveLength(0);
    });

    it('leaves the parent able to log in and keep their profile', async () => {
      const { org, parentToken, profileId } = await seed('remove-soft');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      // Off-boarding ends an association, not an account.
      const profile = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ id: profileId });
      expect(profile).not.toBeNull();
      expect(profile!.displayName).not.toBe('Deleted User');

      await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(parentToken))
        .expect(200)
        .expect((r) => expect(r.body.status).toBe(UserStatus.Active));
    });

    it('reports a second removal as no longer on the roster', async () => {
      const { org, profileId } = await seed('remove-twice');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(404);
    });

    it('refuses a skill-level write against a player already off-boarded', async () => {
      const { org, profileId } = await seed('remove-then-skill');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .send({ skillLevel: 'Elite' })
        .expect(404);
    });

    it('keeps a previously recorded assessment when the player rejoins', async () => {
      const { org, parentToken, profileId } = await seed('remove-rejoin');

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .send({ skillLevel: 'Advanced' })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      // Deactivated, not deleted — the point of the soft removal is that the
      // pairing and its history can be picked back up.
      await join(await shareLinkCode(org), parentToken);

      const active = await roster(org);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ playerProfileId: profileId, skillLevel: 'Advanced' });
    });

    it('leaves the rest of the roster untouched', async () => {
      const { org, profileId } = await seed('remove-others');
      const other = await ctx.registerVerifiedPlayer({ email: 'remove-others-2@example.com' });
      const otherToken = await login(other.email, other.password);
      const otherProfileId = await join(await shareLinkCode(org), otherToken);

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      const active = await roster(org);
      expect(active.map((r) => r.playerProfileId)).toEqual([otherProfileId]);
      expect(await roster(org, true)).toHaveLength(2);
    });

    it('is not the parent’s call through this route', async () => {
      const { parentToken, profileId } = await seed('remove-parent');

      // The family has its own removal; this one is the trainer's.
      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(parentToken))
        .expect(403);
    });

    it('records an audit row', async () => {
      const { org, profileId } = await seed('remove-audit');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      const rows = await ctx.dataSource
        .getRepository(AuditLog)
        .find({ where: { action: 'roster.member-removed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(org.userId);
      expect(rows[0].targetId).toBe(profileId);
    });
  });
});
