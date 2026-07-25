import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { AssociationStatus } from '../src/modules/enrollment/entities/trainer-player-association.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';

/**
 * US-01.02's multi-trainer half:
 *
 *   "If Parent with Children: Show selection prompt — 'Who will train with
 *    [New Trainer]?' … Only selected family members associated with new
 *    trainer."
 *
 * The join endpoint always connected the caller's own profile and nothing
 * else, so a parent joining a trainer on behalf of one child ended up joining
 * personally instead — and there was no way to see or choose.
 */
describe('Family selection on join, and the trainer roster (e2e, US-01.02)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const PASSWORD = 'R0sterStr0ng!Pass';

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

  const makeTrainer = async (
    email: string,
    businessName: string,
    code: string,
  ): Promise<{ token: string; profileId: string; code: string }> => {
    const users = ctx.dataSource.getRepository(User);
    const owner = await users.save(
      users.create({
        email,
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
        passwordHash: await ctx.passwords.hash(PASSWORD),
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
    return { token: await login(email, PASSWORD), profileId: profile.id, code };
  };

  /** A parent already with trainer A, plus two children. */
  const seedFamily = async (): Promise<{
    parentToken: string;
    parentUserId: string;
    selfProfileId: string;
    alexId: string;
    mayaId: string;
  }> => {
    const a = await makeTrainer('rt-a@example.com', 'Alpha Academy', 'rostercodea');
    const parent = await ctx.registerVerifiedPlayer({ email: 'rparent@example.com' });
    const parentToken = await login(parent.email, parent.password);

    await request(app.getHttpServer())
      .post(`/api/v1/join/${a.code}`)
      .set(auth(parentToken))
      .send({})
      .expect(200);

    const mk = async (name: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: name, birthDate: '2014-08-01', gender: 'female' })
        .expect(201);
      return res.body.id as string;
    };

    const listed = await request(app.getHttpServer())
      .get('/api/v1/players')
      .set(auth(parentToken))
      .expect(200);
    const self = (listed.body as Array<{ id: string; isChild: boolean }>).find((p) => !p.isChild);

    return {
      parentToken,
      parentUserId: parent.userId,
      selfProfileId: self?.id ?? '',
      alexId: await mk('Alex'),
      mayaId: await mk('Maya'),
    };
  };

  describe('the selection prompt', () => {
    it('lists the parent and every child, self first', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-b@example.com', 'Beta Club', 'rostercodeb');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/join/${b.code}/members`)
        .set(auth(fam.parentToken))
        .expect(200);

      expect(res.body.trainerName).toBe('Beta Club');
      expect(res.body.members).toHaveLength(3);
      expect(res.body.members[0].isChild).toBe(false);
      expect(res.body.members.map((m: { displayName: string }) => m.displayName)).toEqual(
        expect.arrayContaining(['Alex', 'Maya']),
      );
      expect(
        res.body.members.every((m: { alreadyAssociated: boolean }) => !m.alreadyAssociated),
      ).toBe(true);
    });

    it('flags who is already connected', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .get('/api/v1/join/rostercodea/members')
        .set(auth(fam.parentToken))
        .expect(200);

      const self = (res.body.members as Array<Record<string, unknown>>).find((m) => !m.isChild);
      expect(self?.alreadyAssociated).toBe(true);
      const alex = (res.body.members as Array<Record<string, unknown>>).find(
        (m) => m.displayName === 'Alex',
      );
      expect(alex?.alreadyAssociated).toBe(false);
    });

    it('is not offered to a child account', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-c@example.com', 'Gamma', 'rostercodec');
      const childEmail = 'alex.join@example.com';
      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${fam.alexId}/login`)
        .set(auth(fam.parentToken))
        .send({ email: childEmail, password: PASSWORD })
        .expect(201);
      const childToken = await login(childEmail, PASSWORD);

      await request(app.getHttpServer())
        .get(`/api/v1/join/${b.code}/members`)
        .set(auth(childToken))
        .expect(403);
    });
  });

  describe('joining with a selection', () => {
    it('connects only the chosen members', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-d@example.com', 'Delta', 'rostercoded');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.alexId] })
        .expect(200);

      expect(res.body.playerProfileIds).toEqual([fam.alexId]);

      // The parent joining on a child's behalf must not silently enrol
      // themselves, which is what the old always-self behaviour did.
      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(b.token))
        .expect(200);
      expect(roster.body).toHaveLength(1);
      expect(roster.body[0].displayName).toBe('Alex');
    });

    it('connects several at once, spending one use of the link', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-e@example.com', 'Epsilon', 'rostercodee');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.alexId, fam.mayaId, fam.selfProfileId] })
        .expect(200);

      expect(res.body.playerProfileIds).toHaveLength(3);

      // One redemption, however many members it connected — counting per
      // profile would let a family exhaust a capped link far faster.
      const link = (await ctx.dataSource
        .getRepository(ShareLink)
        .findOne({ where: { code: 'rostercodee' } })) as ShareLink;
      expect(link.useCount).toBe(1);
    });

    it('still joins the caller alone when nothing is selected', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-f@example.com', 'Zeta', 'rostercodef');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({})
        .expect(200);

      expect(res.body.playerProfileIds).toEqual([fam.selfProfileId]);
    });

    it("refuses a selection naming another family's child, without spending the link", async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-g@example.com', 'Eta', 'rostercodeg');

      const stranger = await ctx.registerVerifiedPlayer({ email: 'rstranger@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);

      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(strangerToken))
        .send({ playerProfileIds: [fam.alexId] })
        .expect(404);

      // Refused before the link is locked, so a bad selection cannot burn a
      // use of it on the way to being rejected.
      const link = (await ctx.dataSource
        .getRepository(ShareLink)
        .findOne({ where: { code: 'rostercodeg' } })) as ShareLink;
      expect(link.useCount).toBe(0);
    });

    it('refuses the whole selection when only part of it is theirs', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-h@example.com', 'Theta', 'rostercodeh');
      const stranger = await ctx.registerVerifiedPlayer({ email: 'rstranger2@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);

      // Give the stranger a real profile of their own, so this is genuinely a
      // mixed selection rather than a wholly foreign one.
      const own = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(strangerToken))
        .send({ displayName: 'Theirs', birthDate: '2015-03-03', gender: 'male' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(strangerToken))
        .send({ playerProfileIds: [own.body.id as string, fam.alexId] })
        .expect(404);

      // All or nothing: the valid half must not be joined either, or a caller
      // could probe which ids exist by watching what got through.
      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(b.token))
        .expect(200);
      expect(roster.body).toHaveLength(0);
    });

    it('is idempotent for members already connected', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .post('/api/v1/join/rostercodea')
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.selfProfileId] })
        .expect(200);

      expect(res.body.message).toMatch(/already connected/i);
    });

    it('rejects a malformed selection at the pipe', async () => {
      const fam = await seedFamily();
      await request(app.getHttpServer())
        .post('/api/v1/join/rostercodea')
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: ['not-a-uuid'] })
        .expect(422);
    });
  });

  describe('the trainer roster', () => {
    it('lists connected players with the account behind each one', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-i@example.com', 'Iota', 'rostercodei');
      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.alexId] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(b.token))
        .expect(200);

      expect(res.body).toHaveLength(1);
      // For a child the parent is the contact: a child profile carries no
      // email or phone of its own.
      expect(res.body[0]).toMatchObject({
        displayName: 'Alex',
        isChild: true,
        accountEmail: 'rparent@example.com',
        accountUserId: fam.parentUserId,
        status: AssociationStatus.Active,
      });
    });

    it('shows only this trainer’s players', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-j@example.com', 'Kappa', 'rostercodej');
      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.mayaId] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(b.token))
        .expect(200);

      // The parent and Alex are with Alpha Academy, not this one.
      expect(res.body).toHaveLength(1);
      expect(res.body[0].displayName).toBe('Maya');
    });

    it('searches on player and account name', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-k@example.com', 'Lambda', 'rostercodek');
      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.alexId, fam.mayaId] })
        .expect(200);

      const byName = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .query({ search: 'may' })
        .set(auth(b.token))
        .expect(200);
      expect(byName.body).toHaveLength(1);
      expect(byName.body[0].displayName).toBe('Maya');

      const byAccount = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .query({ search: 'rparent@' })
        .set(auth(b.token))
        .expect(200);
      expect(byAccount.body).toHaveLength(2);
    });

    it('hides disconnected players unless asked', async () => {
      const fam = await seedFamily();
      const b = await makeTrainer('rt-l@example.com', 'Mu', 'rostercodel');
      await request(app.getHttpServer())
        .post(`/api/v1/join/${b.code}`)
        .set(auth(fam.parentToken))
        .send({ playerProfileIds: [fam.alexId] })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/players/${fam.alexId}/trainers/${b.profileId}`)
        .set(auth(fam.parentToken))
        .expect(200);

      const active = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(b.token))
        .expect(200);
      expect(active.body).toHaveLength(0);

      const all = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .query({ includeInactive: true })
        .set(auth(b.token))
        .expect(200);
      expect(all.body).toHaveLength(1);
      expect(all.body[0].status).toBe(AssociationStatus.Inactive);
    });

    it('is trainer-only', async () => {
      const fam = await seedFamily();
      await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(fam.parentToken))
        .expect(403);
    });
  });
});
