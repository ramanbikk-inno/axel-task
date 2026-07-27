import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { PNG_1X1_BASE64 } from './helpers/image.fixtures';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

// What a child login can do for itself: Best Times, own basic profile fields, own photo.
describe('Child self-service (e2e)', () => {
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

  interface Seed {
    parentToken: string;
    childToken: string;
    childProfileId: string;
    siblingProfileId: string;
  }

  /** A parent with two children; only the first gets a login of their own. */
  const seed = async (): Promise<Seed> => {
    await makeTrainer('Coach Bob', 'selfserve1');

    const parent = await ctx.registerVerifiedPlayer({ email: 'ssparent@example.com' });
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
      .post(`/api/v1/players/children/${childProfileId}/login`)
      .set(auth(parentToken))
      .send({ email: 'alex.ss@example.com', password: CHILD_PASSWORD })
      .expect(201);

    return {
      parentToken,
      childToken: await login('alex.ss@example.com', CHILD_PASSWORD),
      childProfileId,
      siblingProfileId,
    };
  };

  describe('Best Times', () => {
    it('lets a child set and read their own availability', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .put(`/api/v1/players/${s.childProfileId}/availability`)
        .set(auth(s.childToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }] })
        .expect(200);

      const read = await request(app.getHttpServer())
        .get(`/api/v1/players/${s.childProfileId}/availability`)
        .set(auth(s.childToken))
        .expect(200);
      expect(read.body).toEqual([
        { dayOfWeek: 1, startTime: '17:00', endTime: '20:00', isAvailable: true },
      ]);
    });

    it('shows the parent what their child set', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .put(`/api/v1/players/${s.childProfileId}/availability`)
        .set(auth(s.childToken))
        .send({ slots: [{ dayOfWeek: 3, startTime: '18:00', endTime: '19:30' }] })
        .expect(200);

      const asParent = await request(app.getHttpServer())
        .get(`/api/v1/players/${s.childProfileId}/availability`)
        .set(auth(s.parentToken))
        .expect(200);
      expect(asParent.body).toHaveLength(1);
      expect(asParent.body[0].startTime).toBe('18:00');
    });

    it("refuses a child their sibling's availability", async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .put(`/api/v1/players/${s.siblingProfileId}/availability`)
        .set(auth(s.childToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }] })
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.PROFILE_NOT_OWNED));

      await request(app.getHttpServer())
        .get(`/api/v1/players/${s.siblingProfileId}/availability`)
        .set(auth(s.childToken))
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.PROFILE_NOT_OWNED));
    });

    it("still refuses another family's profile", async () => {
      const s = await seed();
      const stranger = await ctx.registerVerifiedPlayer({ email: 'ssstranger@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);

      await request(app.getHttpServer())
        .get(`/api/v1/players/${s.childProfileId}/availability`)
        .set(auth(strangerToken))
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.PROFILE_NOT_OWNED));
    });
  });

  describe('own profile', () => {
    it('shows a child their own trainee profile, not an empty one', async () => {
      const s = await seed();

      const me = await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(s.childToken))
        .expect(200);

      expect(me.body.player).not.toBeNull();
      expect(me.body.player.id).toBe(s.childProfileId);
      expect(me.body.player.isChild).toBe(true);
      expect(me.body.player.displayName).toBe('Alex');
    });

    it('lets a child amend the basics their parent left blank', async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(s.childToken))
        .send({ school: 'Riverside High', jerseyNumber: '23' })
        .expect(200);
      expect(res.body.player.school).toBe('Riverside High');
      expect(res.body.player.jerseyNumber).toBe('23');

      // The parent sees the same row, so this reached the profile rather than
      // some copy hanging off the child's account.
      const family = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(s.parentToken))
        .expect(200);
      const child = family.body.find((p: { id: string }) => p.id === s.childProfileId);
      expect(child.school).toBe('Riverside High');
    });

    it('will not let a child move their own birth date or name', async () => {
      const s = await seed();

      // Not merely ignored — rejected, so a client cannot believe it worked.
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(s.childToken))
        .send({ birthDate: '2000-01-01' })
        .expect(422);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(s.childToken))
        .send({ displayName: 'Not Alex' })
        .expect(422);
    });

    it('keeps the adult route closed to a child', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(s.childToken))
        .send({ school: 'Sneaky High' })
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED));
    });

    it('keeps the child route closed to an adult', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(s.parentToken))
        .send({ school: 'Riverside High' })
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.NOT_A_CHILD_PROFILE));
    });
  });

  describe('own photo', () => {
    it("writes a child's photo to the profile everyone else reads", async () => {
      const s = await seed();

      const res = await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(s.childToken))
        .send({ fileName: 'alex.png', mimeType: 'image/png', dataBase64: PNG_1X1_BASE64 })
        .expect(200);
      expect(res.body.photoUrl).toBe('https://storage.test/uploads/mock.png');

      // The column the family view and the trainer roster actually read.
      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: s.childProfileId } })) as PlayerProfile;
      expect(profile.photoUrl).toBe('https://storage.test/uploads/mock.png');

      const family = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(s.parentToken))
        .expect(200);
      const child = family.body.find((p: { id: string }) => p.id === s.childProfileId);
      expect(child.photoUrl).toBe('https://storage.test/uploads/mock.png');
    });

    it('discards the replaced asset rather than orphaning it', async () => {
      const s = await seed();

      ctx.storage.upload
        .mockResolvedValueOnce({ url: 'https://storage.test/a.png', publicId: 'avatars/a' })
        .mockResolvedValueOnce({ url: 'https://storage.test/b.png', publicId: 'avatars/b' });

      const send = (): request.Test =>
        request(app.getHttpServer())
          .post('/api/v1/profile/me/photo')
          .set(auth(s.childToken))
          .send({ fileName: 'alex.png', mimeType: 'image/png', dataBase64: PNG_1X1_BASE64 });

      await send().expect(200);
      await send().expect(200);

      expect(ctx.storage.delete).toHaveBeenCalledWith('avatars/a');
    });

    it('removes it again', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(s.childToken))
        .send({ fileName: 'alex.png', mimeType: 'image/png', dataBase64: PNG_1X1_BASE64 })
        .expect(200);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/profile/me/photo')
        .set(auth(s.childToken))
        .expect(200);
      expect(res.body.photoUrl).toBeNull();

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: s.childProfileId } })) as PlayerProfile;
      expect(profile.photoUrl).toBeNull();
    });

    it('404s when there is nothing to remove', async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .delete('/api/v1/profile/me/photo')
        .set(auth(s.childToken))
        .expect(404);
    });

    it("leaves an adult's photo on their account row", async () => {
      const s = await seed();

      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(s.parentToken))
        .send({ fileName: 'mum.png', mimeType: 'image/png', dataBase64: PNG_1X1_BASE64 })
        .expect(200);

      const parent = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: 'ssparent@example.com' } })) as User;
      expect(parent.photoUrl).toBe('https://storage.test/uploads/mock.png');
    });
  });
});
