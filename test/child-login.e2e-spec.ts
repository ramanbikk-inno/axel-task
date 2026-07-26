import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Child login and its constraints.
 *
 * The case worth being careful about is that a child account carries the same
 * PlayerParent role as its parent. Every `@Roles(Role.PlayerParent)` route
 * admits it by construction, so what a child can actually do is decided by the
 * child branch in AbilityFactory and by NotAChildGuard — not by the role.
 */
describe('Child login (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const CHILD_PASSWORD = 'K1dSafe!Passw0rd';

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

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeTrainer = async (businessName: string, code: string): Promise<string> => {
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
    return profile.id;
  };

  /** A parent with two children, one of whom has a login. */
  const seed = async (): Promise<{
    parentToken: string;
    childToken: string;
    childProfileId: string;
    siblingProfileId: string;
    childEmail: string;
    trainerAId: string;
    codeB: string;
  }> => {
    const trainerAId = await makeTrainer('Coach Bob', 'childbob1');
    await makeTrainer('Coach Lisa', 'childlisa1');

    const parent = await ctx.registerVerifiedPlayer({ email: 'childparent@example.com' });
    const parentToken = await login(parent.email, parent.password);

    const mk = async (name: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: name, birthDate: '2014-08-01', gender: 'female' })
        .expect(201);
      return res.body.id as string;
    };
    const childProfileId = await mk('Alex');
    const siblingProfileId = await mk('Maya');

    await request(app.getHttpServer())
      .post(`/api/v1/players/${childProfileId}/trainers/by-code`)
      .set(auth(parentToken))
      .send({ code: 'childbob1' })
      .expect(200);

    const childEmail = 'alex.child@example.com';
    await request(app.getHttpServer())
      .post(`/api/v1/players/children/${childProfileId}/login`)
      .set(auth(parentToken))
      .send({ email: childEmail, password: CHILD_PASSWORD })
      .expect(201);

    return {
      parentToken,
      childToken: await login(childEmail, CHILD_PASSWORD),
      childProfileId,
      siblingProfileId,
      childEmail,
      trainerAId,
      codeB: 'childlisa1',
    };
  };

  describe('creating the login', () => {
    it('links the account to the child profile and lets it sign in', async () => {
      const s = await seed();

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: s.childProfileId } })) as PlayerProfile;
      expect(profile.childUserId).not.toBeNull();

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(auth(s.childToken))
        .expect(200);
      expect(me.body.isChild).toBe(true);
      expect(me.body.childPlayerProfileId).toBe(s.childProfileId);
    });

    it('refuses a second login for the same child', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/players/children/${s.childProfileId}/login`)
        .set(auth(s.parentToken))
        .send({ email: 'another@example.com', password: CHILD_PASSWORD })
        .expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.CHILD_LOGIN_EXISTS);
    });

    it('refuses an email already in use', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/players/children/${s.siblingProfileId}/login`)
        .set(auth(s.parentToken))
        .send({ email: s.childEmail, password: CHILD_PASSWORD })
        .expect(409);
      expect(res.body.errorCode).toBe(ErrorCode.EMAIL_ALREADY_EXISTS);
    });

    it("refuses another family's child with 404", async () => {
      const s = await seed();
      const stranger = await ctx.registerVerifiedPlayer({ email: 'strange@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);

      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${s.siblingProfileId}/login`)
        .set(auth(strangerToken))
        .send({ email: 'x@example.com', password: CHILD_PASSWORD })
        .expect(404);
    });

    it('holds the password policy', async () => {
      const s = await seed();
      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${s.siblingProfileId}/login`)
        .set(auth(s.parentToken))
        .send({ email: 'weak@example.com', password: 'short' })
        .expect(422);
    });
  });

  describe('what the child can see', () => {
    it('sees its own profile and not its sibling', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(s.childToken))
        .expect(200);

      const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual([s.childProfileId]);
    });

    it('gets a flat trainer list with no "Me" section', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players/context')
        .set(auth(s.childToken))
        .expect(200);

      // A child gets a flat trainer list, with no "Me" section.
      expect(res.body.self).toBeNull();
      expect(res.body.children).toHaveLength(1);
      expect(res.body.children[0].id).toBe(s.childProfileId);
    });

    it('can switch only among its own trainer contexts', async () => {
      const s = await seed();

      const options = await request(app.getHttpServer())
        .get('/api/v1/auth/context')
        .set(auth(s.childToken))
        .expect(200);
      expect(options.body.options).toHaveLength(1);
      expect(options.body.options[0].playerProfileId).toBe(s.childProfileId);

      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(s.childToken))
        .send({ playerProfileId: s.childProfileId, trainerProfileId: s.trainerAId })
        .expect(200);
    });

    it('cannot switch into a sibling context', async () => {
      const s = await seed();

      // The sibling belongs to the same parent, so an ownerUserId-scoped check
      // would have allowed this.
      await request(app.getHttpServer())
        .post('/api/v1/auth/context/switch')
        .set(auth(s.childToken))
        .send({ playerProfileId: s.siblingProfileId, trainerProfileId: s.trainerAId })
        .expect(404);
    });
  });

  describe('what the child cannot do', () => {
    it('is blocked from joining a trainer, and the parent is emailed the link', async () => {
      const s = await seed();
      ctx.mailer.sendChildJoinRequest.mockClear();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/join/${s.codeB}`)
        .set(auth(s.childToken))
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.CHILD_CANNOT_ADD_TRAINER);
      expect(res.body.message).toMatch(/ask your parent/i);

      expect(ctx.mailer.sendChildJoinRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'childparent@example.com',
          childName: 'Alex',
          trainerName: 'Coach Lisa',
        }),
      );

      // And nothing was actually connected.
      const after = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(s.childToken))
        .expect(200);
      expect(after.body[0].trainers).toHaveLength(1);
    });

    it('is still blocked when the parent notification fails', async () => {
      const s = await seed();
      ctx.mailer.sendChildJoinRequest.mockRejectedValueOnce(new Error('provider down'));

      // The block is the security control; a mail outage must not turn it into
      // a 500 that reads, to the child, like a retry might work.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/join/${s.codeB}`)
        .set(auth(s.childToken))
        .expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.CHILD_CANNOT_ADD_TRAINER);
    });

    it.each([
      ['create a sibling', 'post', '/api/v1/players/children'],
      ['mint another child login', 'post', '/api/v1/players/children/:sibling/login'],
    ])('cannot %s', async (_label, _method, path) => {
      const s = await seed();
      const url = path.replace(':sibling', s.siblingProfileId);

      const res = await request(app.getHttpServer())
        .post(url)
        .set(auth(s.childToken))
        .send({
          displayName: 'Ghost',
          birthDate: '2015-01-01',
          email: 'g@example.com',
          password: CHILD_PASSWORD,
        })
        .expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED);
    });

    it('cannot add a trainer to its own profile by code', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/players/${s.childProfileId}/trainers/by-code`)
        .set(auth(s.childToken))
        .send({ code: s.codeB })
        .expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED);
    });

    it('cannot disconnect itself from a trainer', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .delete(`/api/v1/players/${s.childProfileId}/trainers/${s.trainerAId}`)
        .set(auth(s.childToken))
        .expect(403);
    });
  });

  describe('revoking the login', () => {
    it('unlinks the profile and kills the live child session', async () => {
      const s = await seed();

      await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(s.childToken)).expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/players/children/${s.childProfileId}/login`)
        .set(auth(s.parentToken))
        .expect(204);

      // Otherwise the child keeps working for the life of their refresh token
      // after the parent has withdrawn access.
      await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(s.childToken)).expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: s.childEmail, password: CHILD_PASSWORD })
        .expect(403);

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: s.childProfileId } })) as PlayerProfile;
      expect(profile.childUserId).toBeNull();
    });

    it('reports login status to the parent', async () => {
      const s = await seed();

      const before = await request(app.getHttpServer())
        .get(`/api/v1/players/children/${s.childProfileId}/login`)
        .set(auth(s.parentToken))
        .expect(200);
      expect(before.body).toMatchObject({ hasLogin: true, email: s.childEmail });

      const none = await request(app.getHttpServer())
        .get(`/api/v1/players/children/${s.siblingProfileId}/login`)
        .set(auth(s.parentToken))
        .expect(200);
      expect(none.body.hasLogin).toBe(false);
    });
  });
});
