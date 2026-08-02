import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ADULT_DOB, bootstrapE2E, E2EContext } from './setup-e2e';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * The six MVP gaps the Epic-01 audit left open. Each block names the gap it
 * holds shut; a passing suite here is what stops them regressing.
 */
describe('Epic-01 MVP gap closure (e2e)', () => {
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

  const adminToken = async (): Promise<string> => {
    const admin = await ctx.seedSuperAdmin();
    return login(admin.email, admin.password);
  };

  /** A trainer with a login, a static player link and a full branding record. */
  const seedTrainer = async (
    code: string,
    over: Partial<TrainerProfile> = {},
  ): Promise<{ userId: string; profileId: string; email: string; password: string }> => {
    const email = `${code}@example.com`;
    const password = 'Tr41ner!Passw0rd';
    const users = ctx.dataSource.getRepository(User);
    const owner = await users.save(
      users.create({
        email,
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
        firstName: 'Terry',
        lastName: 'Trainer',
        phone: '+1 555 000 1111',
        passwordHash: await ctx.passwords.hash(password),
      }),
    );
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await trainers.save(
      trainers.create({
        userId: owner.id,
        businessName: 'Elite Basketball Academy',
        website: 'https://elite.example.com',
        address: '12 Court Lane',
        description: 'Run out of my home gym',
        ...over,
      }),
    );
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
    return { userId: owner.id, profileId: profile.id, email, password };
  };

  // Gap 1 — erasure reached players and coaches but never the trainer's org.
  describe('GDPR erasure of a trainer organisation', () => {
    it('anonymises business name, address, website and description', async () => {
      const trainer = await seedTrainer('gap1a');
      const token = await adminToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${trainer.userId}`)
        .set(auth(token))
        .send({ reason: 'gdpr request' })
        .expect(200);

      const profile = await ctx.dataSource
        .getRepository(TrainerProfile)
        .findOne({ where: { id: trainer.profileId } });
      expect(profile).not.toBeNull();
      expect(profile).toMatchObject({
        businessName: 'Deleted User',
        website: null,
        address: null,
        description: null,
      });
    });

    it('clears the logo and discards the stored asset behind it', async () => {
      const trainer = await seedTrainer('gap1b', {
        logoUrl: 'https://cdn.example.com/logos/abc.png',
        logoPublicId: 'logos/abc',
      });
      const token = await adminToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${trainer.userId}`)
        .set(auth(token))
        .send({ reason: 'gdpr request' })
        .expect(200);

      const profile = await ctx.dataSource
        .getRepository(TrainerProfile)
        .findOne({ where: { id: trainer.profileId } });
      expect(profile).toMatchObject({ logoUrl: null, logoPublicId: null });
      // Nulling the column alone would leave the image served from the CDN.
      expect(ctx.storage.delete).toHaveBeenCalledWith('logos/abc');
    });

    it('leaves an erased trainer no way back in', async () => {
      const trainer = await seedTrainer('gap1c');
      const token = await adminToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${trainer.userId}`)
        .set(auth(token))
        .send({ reason: 'gdpr request' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: trainer.email, password: trainer.password })
        .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    });
  });

  // Gap 2 — every family route was fenced against children except this one.
  describe('child logins and the common profile', () => {
    interface ChildSeed {
      parentToken: string;
      childToken: string;
      childProfileId: string;
    }

    const seedChild = async (): Promise<ChildSeed> => {
      await seedTrainer('gap2');
      const parent = await ctx.registerVerifiedPlayer({ email: 'gap2parent@example.com' });
      const parentToken = await login(parent.email, parent.password);

      const created = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'male' })
        .expect(201);
      const childProfileId = created.body.id as string;

      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${childProfileId}/login`)
        .set(auth(parentToken))
        .send({ email: 'gap2child@example.com', password: CHILD_PASSWORD })
        .expect(201);

      return {
        parentToken,
        childToken: await login('gap2child@example.com', CHILD_PASSWORD),
        childProfileId,
      };
    };

    it('refuses a child the family phone number on PATCH /profile/me', async () => {
      const s = await seedChild();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(s.childToken))
        .send({ phone: '+1 555 999 0000' })
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED));
    });

    it('rejects the whole patch rather than writing the fields beside the phone', async () => {
      const s = await seedChild();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(s.childToken))
        .send({ firstName: 'Renamed', phone: '+1 555 999 0000' })
        .expect(403);

      const me = await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(s.childToken))
        .expect(200);
      expect(me.body.phone).toBeNull();
      expect(me.body.firstName).not.toBe('Renamed');
    });

    it('still lets the child edit its own name, which US-01.06 grants', async () => {
      const s = await seedChild();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(s.childToken))
        .send({ firstName: 'Alex', lastName: 'Smith' })
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ firstName: 'Alex', lastName: 'Smith' }));
    });

    it('still lets the child edit its own school and jersey number', async () => {
      const s = await seedChild();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(s.childToken))
        .send({ school: 'Lincoln High', jerseyNumber: '23' })
        .expect(200);
    });

    it('leaves the parent’s own profile edit working', async () => {
      const s = await seedChild();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(s.parentToken))
        .send({ firstName: 'Pat', phone: '+1 555 222 3333' })
        .expect(200)
        .expect((r) => expect(r.body.firstName).toBe('Pat'));
    });
  });

  // Gap 4 — a nameless registrant used to land on the roster as their email.
  describe('name is required at registration', () => {
    it('rejects /auth/register without a first name', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'noname@example.com', password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(422);
    });

    it('rejects a ShareLink registration without a first name', async () => {
      await seedTrainer('gap4');

      await request(app.getHttpServer())
        .post('/api/v1/join/gap4/register')
        .send({
          email: 'joinnoname@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
        })
        .expect(422);
    });

    it('accepts a mononym — only the last name is optional', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'mononym@example.com',
          password: 'Str0ng!Passw0rd',
          firstName: 'Prince',
          birthDate: ADULT_DOB,
        })
        .expect(201);
    });
  });

  // Gap 5 — the CRM could not tell a deactivated account from an active one.
  describe('roster shows the account status', () => {
    it('reports Active, then Inactive after a Super Admin deactivation', async () => {
      const trainer = await seedTrainer('gap5');
      const trainerToken = await login(trainer.email, trainer.password);

      const player = await ctx.registerVerifiedPlayer({ email: 'gap5player@example.com' });
      const playerToken = await login(player.email, player.password);
      await request(app.getHttpServer())
        .post('/api/v1/join/gap5')
        .set(auth(playerToken))
        .send({})
        .expect((r) => expect([200, 201]).toContain(r.status));

      const before = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainerToken))
        .expect(200);
      expect(before.body).toHaveLength(1);
      expect(before.body[0].accountStatus).toBe(UserStatus.Active);

      await request(app.getHttpServer())
        .post(`/api/v1/users/${player.userId}/deactivate`)
        .set(auth(await adminToken()))
        .send({})
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainerToken))
        .expect(200);
      expect(after.body).toHaveLength(1);
      // The association is untouched by a deactivation; without accountStatus
      // the row looks identical to an active player's.
      expect(after.body[0].accountStatus).toBe(UserStatus.Inactive);
      expect(after.body[0].status).toBe('active');
    });
  });

  // Gap 6a — the invite form had nowhere to put the coach's name.
  describe('coach invitation carries an optional invitee name', () => {
    it('stores the name and returns it on the pending invitation', async () => {
      const trainer = await seedTrainer('gap6a');
      const trainerToken = await login(trainer.email, trainer.password);

      const created = await request(app.getHttpServer())
        .post('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .send({ email: 'coach@example.com', name: 'Jordan Lee', message: 'Join us' })
        .expect((r) => expect([200, 201]).toContain(r.status));
      expect(created.body.name).toBe('Jordan Lee');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .expect(200);
      expect(listed.body[0].name).toBe('Jordan Lee');
    });

    it('carries the name across a resend', async () => {
      const trainer = await seedTrainer('gap6b');
      const trainerToken = await login(trainer.email, trainer.password);

      const created = await request(app.getHttpServer())
        .post('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .send({ email: 'coach2@example.com', name: 'Jordan Lee' })
        .expect((r) => expect([200, 201]).toContain(r.status));

      const resent = await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${created.body.id}/resend`)
        .set(auth(trainerToken))
        .send({})
        .expect((r) => expect([200, 201]).toContain(r.status));
      expect(resent.body.name).toBe('Jordan Lee');
    });

    it('leaves the name null when the trainer does not supply one', async () => {
      const trainer = await seedTrainer('gap6c');
      const trainerToken = await login(trainer.email, trainer.password);

      const created = await request(app.getHttpServer())
        .post('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .send({ email: 'coach3@example.com' })
        .expect((r) => expect([200, 201]).toContain(r.status));
      expect(created.body.name).toBeNull();
    });
  });

  // Gap 6b — an exact-match 409 was the only duplicate handling there was.
  describe('similar-child warning', () => {
    const seedParent = async (): Promise<string> => {
      await seedTrainer('gap6d');
      const parent = await ctx.registerVerifiedPlayer({ email: 'gap6parent@example.com' });
      const token = await login(parent.email, parent.password);
      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({ displayName: 'Alexander Smith', birthDate: '2014-08-01', gender: 'male' })
        .expect(201);
      return token;
    };

    it('warns on a nickname of an existing child without blocking', async () => {
      const token = await seedParent();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players/children/similar')
        .query({ displayName: 'Alex Smith', birthDate: '2014-08-01' })
        .set(auth(token))
        .expect(200);

      expect(res.body.hasExactMatch).toBe(false);
      expect(res.body.matches).toHaveLength(1);
      expect(res.body.matches[0]).toMatchObject({ displayName: 'Alexander Smith', exact: false });

      // Advisory only: the create still goes through.
      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({ displayName: 'Alex Smith', birthDate: '2014-08-01', gender: 'male' })
        .expect(201);
    });

    it('flags an exact collision before the create call is made', async () => {
      const token = await seedParent();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players/children/similar')
        .query({ displayName: 'Alexander Smith', birthDate: '2014-08-01' })
        .set(auth(token))
        .expect(200);

      expect(res.body.hasExactMatch).toBe(true);
      expect(res.body.matches[0].exact).toBe(true);
    });

    it('reports nothing for an unrelated name', async () => {
      const token = await seedParent();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players/children/similar')
        .query({ displayName: 'Jordan Lee', birthDate: '2014-08-01' })
        .set(auth(token))
        .expect(200);

      expect(res.body).toEqual({ matches: [], hasExactMatch: false });
    });

    it('still refuses an exact duplicate by default', async () => {
      const token = await seedParent();

      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({ displayName: 'Alexander Smith', birthDate: '2014-08-01', gender: 'male' })
        .expect(409)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.DUPLICATE_CHILD));
    });

    it('lets a parent add twins with allowDuplicate', async () => {
      const token = await seedParent();

      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({
          displayName: 'Alexander Smith',
          birthDate: '2014-08-01',
          gender: 'male',
          allowDuplicate: true,
        })
        .expect(201);

      const family = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(token))
        .expect(200);
      const twins = family.body.filter(
        (p: { displayName: string }) => p.displayName === 'Alexander Smith',
      );
      expect(twins).toHaveLength(2);
    });

    it('refuses a child login the preflight — it is a parent tool', async () => {
      const token = await seedParent();
      const created = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({ displayName: 'Maya Smith', birthDate: '2016-02-11', gender: 'female' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${created.body.id}/login`)
        .set(auth(token))
        .send({ email: 'maya.gap6@example.com', password: CHILD_PASSWORD })
        .expect(201);
      const childToken = await login('maya.gap6@example.com', CHILD_PASSWORD);

      await request(app.getHttpServer())
        .get('/api/v1/players/children/similar')
        .query({ displayName: 'Alex Smith' })
        .set(auth(childToken))
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED));
    });
  });
});
