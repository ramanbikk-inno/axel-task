import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { bootstrapE2E, E2EContext } from './setup-e2e';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Registration collects a birth date to run the minimum-age check, so it has to
 * keep it. It used to be validated and dropped: the self profile was created
 * later with a null date and no endpoint could ever set one, while the ShareLink
 * registration path persisted the same field.
 */
describe('Birth date on the account holder’s own profile (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const ADULT_DOB = '1994-03-22';

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

  const selfProfileOf = async (userId: string): Promise<PlayerProfile | null> =>
    ctx.dataSource.getRepository(PlayerProfile).findOneBy({ ownerUserId: userId, isChild: false });

  describe('POST /auth/register', () => {
    it('keeps the birth date it just validated', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'keeps@example.com' });

      const profile = await selfProfileOf(parent.userId);
      expect(profile).not.toBeNull();
      expect(profile!.birthDate).toBe('1994-03-22');
      expect(profile!.isChild).toBe(false);
    });

    it('reports it back through the profile endpoint', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'reports@example.com' });
      const token = await login(parent.email, parent.password);

      const res = await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(token))
        .expect(200);
      expect(res.body.player.birthDate).toBe('1994-03-22');
    });

    it('creates exactly one profile, not one per registration attempt', async () => {
      const email = 'once@example.com';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(201);
      // Enumeration-safe: the second attempt is a silent no-op, and must not
      // leave a second profile behind either.
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(201);

      expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(1);
    });

    it('leaves no profile behind when the age check rejects the registration', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'minor@example.com', password: 'Str0ng!Passw0rd', birthDate: '2015-01-01' })
        .expect(403);

      expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(0);
    });

    it('names the profile after the registrant, falling back to the email', async () => {
      const named = await ctx.registerVerifiedPlayer({ email: 'named@example.com' });
      const namedProfile = await selfProfileOf(named.userId);
      // registerVerifiedPlayer supplies first and last names.
      expect(namedProfile!.displayName).not.toBe('named@example.com');

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'bare@example.com', password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(201);
      const bare = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ displayName: 'bare@example.com' });
      expect(bare).not.toBeNull();
    });
  });

  describe('the date survives into the flows that need it', () => {
    it('shows on the trainer’s roster after the player joins', async () => {
      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: 'roster-trainer@example.com',
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      await trainers.save(trainers.create({ userId: trainerUser.id, businessName: 'Elite' }));
      const trainerToken = await login('roster-trainer@example.com', FACTORY_PASSWORD);

      const parent = await ctx.registerVerifiedPlayer({ email: 'roster-player@example.com' });
      const parentToken = await login(parent.email, parent.password);

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainerToken))
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(parentToken))
        .send({})
        .expect(200);

      // The join used to create the self profile from scratch with a null date,
      // discarding what registration had already been told.
      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainerToken))
        .expect(200);
      expect(roster.body).toHaveLength(1);
      expect(roster.body[0].birthDate).toBe('1994-03-22');
    });

    it('matches what the ShareLink registration path stores', async () => {
      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: 'parity-trainer@example.com',
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      await trainers.save(trainers.create({ userId: trainerUser.id, businessName: 'Elite' }));
      const trainerToken = await login('parity-trainer@example.com', FACTORY_PASSWORD);

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainerToken))
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}/register`)
        .send({
          email: 'via-link@example.com',
          password: 'Str0ng!Passw0rd',
          firstName: 'Sam',
          birthDate: ADULT_DOB,
        })
        .expect(201);

      // Both doors onto an account now leave the same thing behind.
      const viaLink = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ displayName: 'Sam' });
      expect(viaLink!.birthDate).toBe('1994-03-22');
    });
  });

  describe('PATCH /profile/me/player', () => {
    it('corrects a birth date the registrant got wrong', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'fix@example.com' });
      const token = await login(parent.email, parent.password);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: '1990-06-15' })
        .expect(200);
      expect(res.body.player.birthDate).toBe('1990-06-15');
    });

    it('refuses a date that would make the account holder a minor', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'downgrade@example.com' });
      const token = await login(parent.email, parent.password);

      // Otherwise the age gate is only enforced at the moment of registration,
      // and one PATCH later undoes it.
      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: '2015-01-01' })
        .expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.UNDERAGE_SELF_REGISTRATION);

      const profile = await selfProfileOf(parent.userId);
      expect(profile!.birthDate).toBe('1994-03-22');
    });

    it('refuses a future date', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'future@example.com' });
      const token = await login(parent.email, parent.password);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: '2030-01-01' })
        .expect(400);
    });

    it('refuses a null — there is no age to check against one', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'null-dob@example.com' });
      const token = await login(parent.email, parent.password);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: null })
        .expect(422);
    });

    it('refuses a date-time, matching the child-profile rule', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'datetime@example.com' });
      const token = await login(parent.email, parent.password);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: '1990-06-15T00:00:00.000Z' })
        .expect(422);
    });

    it('leaves the date alone when the request does not mention it', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'untouched@example.com' });
      const token = await login(parent.email, parent.password);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ school: 'Riverside High' })
        .expect(200);
      expect(res.body.player).toMatchObject({
        school: 'Riverside High',
        birthDate: '1994-03-22',
      });
    });

    it('does not touch a child’s birth date', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'child-safe@example.com' });
      const token = await login(parent.email, parent.password);
      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(token))
        .send({ displayName: 'Maya', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: '1990-06-15' })
        .expect(200);

      // updateSelfProfile is scoped to isChild=false, so the child is untouched.
      const stored = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ id: child.body.id as string });
      expect(stored!.birthDate).toBe('2014-08-01');
    });
  });
});
