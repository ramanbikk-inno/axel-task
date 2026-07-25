import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { CoachProfile, CoachStatus } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Two gaps that share a cause.
 *
 * Uploads stored only the delivery URL and threw away the provider's public
 * id, which is the only handle that can delete an asset — so every replaced
 * avatar and logo stayed in storage forever, with nothing left pointing at it.
 * And a coach, who the spec says "may edit their own profile", had no endpoint
 * to do it with.
 */
describe('Profile and branding lifecycle (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const PASSWORD = 'Pr0fileStr0ng!Pass';
  // A 1x1 PNG, small enough to inline.
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
    ctx.storage.upload.mockReset();
    ctx.storage.delete.mockReset();
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

  const makeUser = async (email: string, role: Role): Promise<User> => {
    const users = ctx.dataSource.getRepository(User);
    return users.save(
      users.create({
        email,
        role,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
        passwordHash: await ctx.passwords.hash(PASSWORD),
      }),
    );
  };

  const makeTrainer = async (
    email: string,
  ): Promise<{ token: string; profileId: string; userId: string }> => {
    const owner = await makeUser(email, Role.Trainer);
    const profile = await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(
        ctx.dataSource
          .getRepository(TrainerProfile)
          .create({ userId: owner.id, businessName: 'Org' }),
      );
    return { token: await login(email, PASSWORD), profileId: profile.id, userId: owner.id };
  };

  const photoPayload = { fileName: 'me.png', mimeType: 'image/png', dataBase64: PNG };

  describe('profile photo', () => {
    it('stores the public id alongside the url', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'photo1@example.com' });
      const token = await login(player.email, player.password);
      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/a.png', publicId: 'avatars/a' });

      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload)
        .expect(200);

      const user = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { id: player.userId } })) as User;
      expect(user.photoUrl).toBe('https://cdn/a.png');
      // Without this the old asset can never be found again, let alone deleted.
      expect(user.photoPublicId).toBe('avatars/a');
    });

    it('deletes the superseded asset when a photo is replaced', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'photo2@example.com' });
      const token = await login(player.email, player.password);

      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/a.png', publicId: 'avatars/a' });
      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload)
        .expect(200);
      expect(ctx.storage.delete).not.toHaveBeenCalled();

      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/b.png', publicId: 'avatars/b' });
      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload)
        .expect(200);

      expect(ctx.storage.delete).toHaveBeenCalledTimes(1);
      expect(ctx.storage.delete).toHaveBeenCalledWith('avatars/a');

      const user = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { id: player.userId } })) as User;
      expect(user.photoPublicId).toBe('avatars/b');
    });

    it('keeps the profile usable when the cleanup fails', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'photo3@example.com' });
      const token = await login(player.email, player.password);

      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/a.png', publicId: 'avatars/a' });
      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload)
        .expect(200);

      // The row is already consistent by the time cleanup runs, so an orphaned
      // asset must not become a failed request for the user.
      ctx.storage.delete.mockRejectedValueOnce(new Error('provider down'));
      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/b.png', publicId: 'avatars/b' });
      const res = await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload);

      expect(res.status).toBe(200);
      expect(res.body.photoUrl).toBe('https://cdn/b.png');
    });

    it('removes the photo and the asset behind it', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'photo4@example.com' });
      const token = await login(player.email, player.password);
      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/a.png', publicId: 'avatars/a' });
      await request(app.getHttpServer())
        .post('/api/v1/profile/me/photo')
        .set(auth(token))
        .send(photoPayload)
        .expect(200);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/profile/me/photo')
        .set(auth(token))
        .expect(200);

      expect(res.body.photoUrl).toBeNull();
      expect(ctx.storage.delete).toHaveBeenCalledWith('avatars/a');
    });

    it('404s when there is no photo to remove', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'photo5@example.com' });
      const token = await login(player.email, player.password);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/profile/me/photo')
        .set(auth(token))
        .expect(404);
      expect(res.body.errorCode).toBe(ErrorCode.NOT_FOUND);
      expect(ctx.storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('trainer logo', () => {
    const logoPayload = { fileName: 'logo.png', mimeType: 'image/png', dataBase64: PNG };

    it('replaces and cleans up', async () => {
      const trainer = await makeTrainer('logo1@example.com');

      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/l1.png', publicId: 'logos/l1' });
      await request(app.getHttpServer())
        .post('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .send(logoPayload)
        .expect(200);

      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/l2.png', publicId: 'logos/l2' });
      const res = await request(app.getHttpServer())
        .post('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .send(logoPayload)
        .expect(200);

      expect(res.body.logoUrl).toBe('https://cdn/l2.png');
      expect(ctx.storage.delete).toHaveBeenCalledWith('logos/l1');

      const profile = (await ctx.dataSource
        .getRepository(TrainerProfile)
        .findOne({ where: { id: trainer.profileId } })) as TrainerProfile;
      expect(profile.logoPublicId).toBe('logos/l2');
    });

    it('removes the logo', async () => {
      const trainer = await makeTrainer('logo2@example.com');
      ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/l1.png', publicId: 'logos/l1' });
      await request(app.getHttpServer())
        .post('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .send(logoPayload)
        .expect(200);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .expect(200);

      expect(res.body.logoUrl).toBeNull();
      expect(ctx.storage.delete).toHaveBeenCalledWith('logos/l1');
    });

    it('404s when there is no logo', async () => {
      const trainer = await makeTrainer('logo3@example.com');
      await request(app.getHttpServer())
        .delete('/api/v1/trainers/me/logo')
        .set(auth(trainer.token))
        .expect(404);
    });

    it('is trainer-only', async () => {
      const player = await ctx.registerVerifiedPlayer({ email: 'nologo@example.com' });
      const token = await login(player.email, player.password);
      await request(app.getHttpServer())
        .delete('/api/v1/trainers/me/logo')
        .set(auth(token))
        .expect(403);
    });
  });

  describe('coach self-service profile', () => {
    /** A trainer with one active coach, both able to sign in. */
    const seed = async (): Promise<{ coachToken: string; coachProfileId: string }> => {
      const trainer = await makeTrainer('coachboss@example.com');
      const coachUser = await makeUser('selfcoach@example.com', Role.Coach);
      const coaches = ctx.dataSource.getRepository(CoachProfile);
      const profile = await coaches.save(
        coaches.create({
          userId: coachUser.id,
          trainerProfileId: trainer.profileId,
          publicVisible: false,
          status: CoachStatus.Active,
          joinedAt: new Date(),
          endedAt: null,
        }),
      );
      return {
        coachToken: await login('selfcoach@example.com', PASSWORD),
        coachProfileId: profile.id,
      };
    };

    it('reads and updates its own bio, credentials and visibility', async () => {
      const s = await seed();

      const before = await request(app.getHttpServer())
        .get('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .expect(200);
      expect(before.body.id).toBe(s.coachProfileId);
      expect(before.body.publicVisible).toBe(false);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .send({
          bio: 'Ten years coaching juniors.',
          credentials: 'BSc Sports Science',
          certifications: 'Level 3',
          publicVisible: true,
        })
        .expect(200);

      expect(res.body).toMatchObject({
        bio: 'Ten years coaching juniors.',
        publicVisible: true,
      });
    });

    it('leaves fields it was not given alone', async () => {
      const s = await seed();
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .send({ bio: 'First' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .send({ publicVisible: true })
        .expect(200);

      expect(res.body.bio).toBe('First');
    });

    it('cannot reassign itself to another trainer or reactivate itself', async () => {
      const s = await seed();
      // Employment is the trainer's to set, so those fields are not in the DTO
      // at all and the global whitelist pipe rejects them outright.
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .send({ trainerProfileId: '11111111-1111-4111-8111-111111111111' })
        .expect(422);

      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(s.coachToken))
        .send({ status: 'Active' })
        .expect(422);
    });

    it('is refused once the engagement has ended', async () => {
      const s = await seed();
      await ctx.dataSource
        .getRepository(CoachProfile)
        .update({ id: s.coachProfileId }, { status: CoachStatus.Inactive, endedAt: new Date() });

      // The profile is resolved from the *active* engagement, so an
      // off-boarded coach has none to edit.
      const fresh = await login('selfcoach@example.com', PASSWORD);
      const res = await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(fresh))
        .send({ bio: 'Still here?' })
        .expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.COACH_PROFILE_NOT_FOUND);
    });

    it('is coach-only', async () => {
      const trainer = await makeTrainer('nocoach@example.com');
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(trainer.token))
        .send({ bio: 'x' })
        .expect(403);
    });
  });
});
