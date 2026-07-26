import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { AuthSession } from '../src/modules/auth/entities/auth-session.entity';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Multi-trainer players see separated views . A context is a
 * (profile, trainer) pair — "Alex → Coach Bob" — so the interesting cases are
 * the ones where the trainer alone is ambiguous, and the ones where a caller
 * tries to select a pair that is not theirs.
 */
describe('Auth context switching (e2e)', () => {
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

  /** A trainer org with a static player ShareLink, created directly. */
  const makeTrainer = async (
    businessName: string,
    code: string,
  ): Promise<{ trainerProfileId: string; code: string }> => {
    const users = ctx.dataSource.getRepository(User);
    const owner = await users.save(
      users.create({
        email: `${code}@example.com`,
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
      }),
    );
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await trainers.save(trainers.create({ userId: owner.id, businessName }));
    const links = ctx.dataSource.getRepository(ShareLink);
    await links.save(
      links.create({
        code,
        type: ShareLinkType.PlayerStatic,
        trainerProfileId: profile.id,
        createdByUserId: owner.id,
        active: true,
        useCount: 0,
      }),
    );
    return { trainerProfileId: profile.id, code };
  };

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const addChild = async (token: string, displayName: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(token))
      .send({ displayName, birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    return res.body.id as string;
  };

  const connect = async (token: string, profileId: string, code: string): Promise<void> => {
    await request(app.getHttpServer())
      .post(`/api/v1/players/${profileId}/trainers/by-code`)
      .set(auth(token))
      .send({ code })
      .expect(200);
  };

  /** A parent whose self profile is with trainer A, plus two children with A. */
  const seedFamily = async (): Promise<{
    token: string;
    selfProfileId: string;
    alexId: string;
    mayaId: string;
    trainerA: string;
    trainerB: string;
  }> => {
    const a = await makeTrainer('Coach Bob', 'bobcode1');
    const b = await makeTrainer('Coach Lisa', 'lisacode1');

    const parent = await ctx.registerVerifiedPlayer({ email: 'parent@example.com' });
    const token = await login(parent.email, parent.password);

    // The parent's own trainee profile: joining as an existing player creates
    // the self profile if there isn't one yet.
    await request(app.getHttpServer()).post(`/api/v1/join/${a.code}`).set(auth(token)).expect(200);

    const listed = await request(app.getHttpServer())
      .get('/api/v1/players')
      .set(auth(token))
      .expect(200);
    const self = (listed.body as Array<{ id: string; isChild: boolean }>).find((p) => !p.isChild);
    const selfProfileId = self?.id ?? '';

    const alexId = await addChild(token, 'Alex');
    const mayaId = await addChild(token, 'Maya');
    // Both children with the same trainer: the case where a trainer id alone
    // cannot say which context is meant.
    await connect(token, alexId, a.code);
    await connect(token, mayaId, a.code);
    await connect(token, mayaId, b.code);

    return {
      token,
      selfProfileId,
      alexId,
      mayaId,
      trainerA: a.trainerProfileId,
      trainerB: b.trainerProfileId,
    };
  };

  it('lists every (profile, trainer) pair the parent may switch to', async () => {
    const fam = await seedFamily();

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/context')
      .set(auth(fam.token))
      .expect(200);

    expect(res.body.active).toBeNull();
    const pairs = (res.body.options as Array<Record<string, string>>).map(
      (o) => `${o.playerDisplayName}->${o.trainerBusinessName}`,
    );
    expect(pairs).toEqual(
      expect.arrayContaining(['Alex->Coach Bob', 'Maya->Coach Bob', 'Maya->Coach Lisa']),
    );
  });

  it('distinguishes two children sharing one trainer', async () => {
    const fam = await seedFamily();

    // Read back through GET rather than trusting the switch response: the
    // response could echo the request and look right while nothing was stored.
    const readBack = async (): Promise<Record<string, string>> => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/context')
        .set(auth(fam.token))
        .expect(200);
      return res.body.active as Record<string, string>;
    };

    await request(app.getHttpServer())
      .post('/api/v1/auth/context/switch')
      .set(auth(fam.token))
      .send({ playerProfileId: fam.alexId, trainerProfileId: fam.trainerA })
      .expect(200);
    expect(await readBack()).toMatchObject({
      playerDisplayName: 'Alex',
      trainerProfileId: fam.trainerA,
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/context/switch')
      .set(auth(fam.token))
      .send({ playerProfileId: fam.mayaId, trainerProfileId: fam.trainerA })
      .expect(200);
    // Same trainer, different context — which the old trainer-only session
    // column could not represent at all.
    expect(await readBack()).toMatchObject({
      playerDisplayName: 'Maya',
      trainerProfileId: fam.trainerA,
    });
  });

  it('persists the selection on the session, so it survives a refresh', async () => {
    const fam = await seedFamily();

    await request(app.getHttpServer())
      .post('/api/v1/auth/context/switch')
      .set(auth(fam.token))
      .send({ playerProfileId: fam.mayaId, trainerProfileId: fam.trainerB })
      .expect(200);

    const sessions = await ctx.dataSource.getRepository(AuthSession).find();
    const live = sessions.filter((s) => s.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0].activePlayerProfileId).toBe(fam.mayaId);
    expect(live[0].activeTrainerProfileId).toBe(fam.trainerB);

    const after = await request(app.getHttpServer())
      .get('/api/v1/auth/context')
      .set(auth(fam.token))
      .expect(200);
    expect(after.body.active.playerDisplayName).toBe('Maya');
    expect(after.body.active.trainerBusinessName).toBe('Coach Lisa');
  });

  it('hands back a working access token carrying the new context', async () => {
    const fam = await seedFamily();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/context/switch')
      .set(auth(fam.token))
      .send({ playerProfileId: fam.alexId, trainerProfileId: fam.trainerA })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.accessToken).not.toBe(fam.token);
    expect(res.body.expiresIn).toBe(900);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(auth(res.body.accessToken as string))
      .expect(200);
  });

  it('clears back to no selection', async () => {
    const fam = await seedFamily();

    await request(app.getHttpServer())
      .post('/api/v1/auth/context/switch')
      .set(auth(fam.token))
      .send({ playerProfileId: fam.alexId, trainerProfileId: fam.trainerA })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/api/v1/auth/context')
      .set(auth(fam.token))
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/context')
      .set(auth(fam.token))
      .expect(200);
    expect(res.body.active).toBeNull();
  });

  describe('what a caller must not be able to select', () => {
    it("refuses another family's child with 404, not 403", async () => {
      const fam = await seedFamily();

      const stranger = await ctx.registerVerifiedPlayer({ email: 'stranger@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(strangerToken))
        .send({ playerProfileId: fam.alexId, trainerProfileId: fam.trainerA })
        .expect(404);

      // 403 would confirm the id names a real profile belonging to someone
      // else, which is enough to enumerate other families' children.
      expect(res.body.errorCode).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses a trainer the profile is not associated with', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(fam.token))
        // Alex is with Coach Bob only; Coach Lisa is Maya's.
        .send({ playerProfileId: fam.alexId, trainerProfileId: fam.trainerB })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.TRAINER_NOT_ASSOCIATED);
    });

    it('refuses a context whose association has been deactivated', async () => {
      const fam = await seedFamily();

      await request(app.getHttpServer())
        .delete(`/api/v1/players/${fam.mayaId}/trainers/${fam.trainerB}`)
        .set(auth(fam.token))
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(fam.token))
        .send({ playerProfileId: fam.mayaId, trainerProfileId: fam.trainerB })
        .expect(403);
    });

    it('drops a live session out of a context that is disconnected under it', async () => {
      const fam = await seedFamily();

      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(fam.token))
        .send({ playerProfileId: fam.mayaId, trainerProfileId: fam.trainerB })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/players/${fam.mayaId}/trainers/${fam.trainerB}`)
        .set(auth(fam.token))
        .expect(200);

      // Otherwise the session keeps naming a trainer this profile is no longer
      // connected to, and anything scoped to the active context stays pointed
      // at data the parent has just disconnected from.
      const sessions = await ctx.dataSource.getRepository(AuthSession).find();
      const live = sessions.filter((s) => s.revokedAt === null);
      expect(live[0].activePlayerProfileId).toBeNull();
      expect(live[0].activeTrainerProfileId).toBeNull();
    });

    it('is not available to a Super Admin', async () => {
      const sa = await ctx.seedSuperAdmin();
      const token = await login(sa.email, sa.password);

      // Tenancy for every other role is derived, not chosen.
      await request(app.getHttpServer()).get('/api/v1/auth/context').set(auth(token)).expect(403);
    });

    it.each([
      ['a malformed profile id', { playerProfileId: 'nope', trainerProfileId: null }],
      ['a missing trainer id', { playerProfileId: null }],
    ])('rejects %s at the pipe', async (_label, body) => {
      const fam = await seedFamily();
      const payload: Record<string, unknown> = { ...body };
      if (payload.playerProfileId === null) {
        payload.playerProfileId = fam.alexId;
      }
      if (payload.trainerProfileId === null) {
        payload.trainerProfileId = fam.trainerA;
      }
      if (_label === 'a missing trainer id') {
        delete payload.trainerProfileId;
      }

      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(fam.token))
        .send(payload)
        .expect(422);
    });
  });
});
