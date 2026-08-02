import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { ADULT_DOB, bootstrapE2E, E2EContext } from './setup-e2e';
import { EmailVerificationToken } from '../src/modules/auth/entities/email-verification-token.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { PlayersService } from '../src/modules/players/players.service';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { UsersService } from '../src/modules/users/users.service';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/** Registration collects a birth date for the age check, so it has to keep it. */
describe('Birth date on the account holder’s own profile (e2e)', () => {
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

  afterEach(() => {
    // Restored here rather than at the end of each test: an assertion that
    // throws would otherwise leave a spy in place for whatever runs next.
    jest.restoreAllMocks();
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
      expect(profile!.birthDate).toBe(ADULT_DOB);
      expect(profile!.isChild).toBe(false);
    });

    it('reports it back through the profile endpoint', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'reports@example.com' });
      const token = await login(parent.email, parent.password);

      const res = await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(token))
        .expect(200);
      expect(res.body.player.birthDate).toBe(ADULT_DOB);
    });

    it('creates exactly one profile, not one per registration attempt', async () => {
      const email = 'once@example.com';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB, firstName: 'Reg' })
        .expect(201);
      // Enumeration-safe: the second attempt is a silent no-op, and must not
      // leave a second profile behind either.
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB, firstName: 'Reg' })
        .expect(201);

      expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(1);
    });

    it('leaves no profile behind when the age check rejects the registration', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'minor@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: '2015-01-01',
          firstName: 'Reg',
        })
        .expect(403);

      expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(0);
    });

    it('names the profile after the registrant, and no longer accepts a nameless one', async () => {
      const named = await ctx.registerVerifiedPlayer({ email: 'named@example.com' });
      const namedProfile = await selfProfileOf(named.userId);
      // registerVerifiedPlayer supplies first and last names.
      expect(namedProfile!.displayName).not.toBe('named@example.com');

      // The email fallback in displayNameFor used to be reachable from here,
      // which put a raw address on the trainer's roster. RegisterDto now
      // requires a first name, so the only way in is with one.
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'bare@example.com', password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(422);
      expect(
        await ctx.dataSource
          .getRepository(PlayerProfile)
          .findOneBy({ displayName: 'bare@example.com' }),
      ).toBeNull();
    });
  });

  describe('registration is all-or-nothing', () => {
    it('rolls the account back if the profile cannot be written', async () => {
      const players = app.get(PlayersService);
      jest.spyOn(players, 'create').mockRejectedValueOnce(new Error('profile insert failed'));

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'rollback@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
          firstName: 'Reg',
        })
        .expect(500);

      // Without a transaction the user row would survive with no profile, so the
      // birth date would be gone for good — nothing asks the registrant again.
      expect(await ctx.dataSource.getRepository(User).count()).toBe(0);
      expect(await ctx.dataSource.getRepository(PlayerProfile).count()).toBe(0);
      expect(await ctx.dataSource.getRepository(EmailVerificationToken).count()).toBe(0);
    });

    it('lets the address be registered again after such a rollback', async () => {
      const players = app.get(PlayersService);
      jest.spyOn(players, 'create').mockRejectedValueOnce(new Error('profile insert failed'));

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'retry@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
          firstName: 'Reg',
        })
        .expect(500);
      jest.restoreAllMocks();

      // The enumeration-safe no-op on an existing address would otherwise strand
      // the caller: no account usable, and no way to make one.
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'retry@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
          firstName: 'Reg',
        })
        .expect(201);

      const profile = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ displayName: 'Reg' });
      expect(profile!.birthDate).toBe(ADULT_DOB);
    });

    it('stays enumeration-safe when the existence check loses a race', async () => {
      const taken = 'taken@example.com';
      await ctx.registerVerifiedPlayer({ email: taken });

      // Forcing the existence check to miss reproduces the concurrent-registration
      // window without depending on timing.
      const users = app.get(UsersService);
      jest.spyOn(users, 'findByEmail').mockResolvedValueOnce(null);

      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send({
        email: taken,
        password: 'Str0ng!Passw0rd',
        birthDate: ADULT_DOB,
        firstName: 'Reg',
      });

      // A 409 here would tell an unauthenticated caller the address is taken,
      // which is exactly what the generic 201 exists to hide.
      expect(res.status).toBe(201);
      expect(await ctx.dataSource.getRepository(User).count()).toBe(1);
    });

    it('does not send a verification email when the transaction fails', async () => {
      const players = app.get(PlayersService);
      jest.spyOn(players, 'create').mockRejectedValueOnce(new Error('profile insert failed'));
      ctx.mailer.sendVerification.mockClear();

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'no-mail@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
          firstName: 'Reg',
        })
        .expect(500);

      // The mail goes out after the commit, so a rolled-back registration must
      // not have told anyone their account exists.
      expect(ctx.mailer.sendVerification).not.toHaveBeenCalled();
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
      expect(roster.body[0].birthDate).toBe(ADULT_DOB);
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
      expect(viaLink!.birthDate).toBe(ADULT_DOB);
    });
  });

  describe('erasure', () => {
    const deleteUser = async (userId: string): Promise<void> => {
      const sa = await ctx.seedSuperAdmin();
      const adminToken = await login(sa.email, sa.password);
      await request(app.getHttpServer())
        .delete(`/api/v1/users/${userId}`)
        .set(auth(adminToken))
        .send({ reason: 'Account holder exercised right to erasure.' })
        .expect(200);
    };

    it('clears the birth date off the account holder’s own profile', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'erase-self@example.com' });
      expect((await selfProfileOf(parent.userId))!.birthDate).toBe(ADULT_DOB);

      await deleteUser(parent.userId);

      // A date of birth is now stored for every single registrant, where before
      // this it was stored for none of them, so the erasure sweep has to reach it.
      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { ownerUserId: parent.userId }, withDeleted: true })) as PlayerProfile;
      expect(profile.birthDate).toBeNull();
      expect(profile.displayName).toBe('Deleted User');
    });

    it('clears it for an account that never joined a trainer', async () => {
      // The profile exists from registration alone now, so it can be erased
      // without the account ever having been used.
      const parent = await ctx.registerVerifiedPlayer({ email: 'erase-unused@example.com' });
      await deleteUser(parent.userId);

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { ownerUserId: parent.userId }, withDeleted: true })) as PlayerProfile;
      expect(profile.birthDate).toBeNull();
    });

    it('gives a re-registered address a fresh date rather than the erased one', async () => {
      const first = await ctx.registerVerifiedPlayer({ email: 'resurrect@example.com' });
      await deleteUser(first.userId);

      // The erased account keeps its anonymised row; the new one is a new user
      // with a new profile, and must not inherit anything from it.
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'resurrect@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: '1988-11-30',
          firstName: 'Reg',
        })
        .expect(201);

      const fresh = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ birthDate: '1988-11-30' });
      expect(fresh).not.toBeNull();
      expect(fresh!.ownerUserId).not.toBe(first.userId);
      expect((await selfProfileOf(first.userId))!.birthDate).toBeNull();
    });
  });

  describe('the new profile does not disturb the flows around it', () => {
    it('offers no context to switch to before any trainer is joined', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'no-context@example.com' });
      const token = await login(parent.email, parent.password);

      // A profile now exists from registration, but a context needs an active
      // association, so the selector must still be empty.
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/context')
        .set(auth(token))
        .expect(200);
      expect(res.body.active).toBeNull();
      expect(res.body.options).toHaveLength(0);
    });

    it('lists the account holder alone in the family view', async () => {
      const parent = await ctx.registerVerifiedPlayer({ email: 'family-solo@example.com' });
      const token = await login(parent.email, parent.password);

      const res = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(token))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ isChild: false, birthDate: ADULT_DOB });
      expect(res.body[0].trainers).toHaveLength(0);
    });

    it('does not put the account holder on any trainer’s roster', async () => {
      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: 'empty-roster@example.com',
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      await trainers.save(trainers.create({ userId: trainerUser.id, businessName: 'Elite' }));
      const trainerToken = await login('empty-roster@example.com', FACTORY_PASSWORD);

      await ctx.registerVerifiedPlayer({ email: 'unconnected@example.com' });

      // The roster is driven by associations, not by the existence of a profile.
      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainerToken))
        .expect(200);
      expect(roster.body).toHaveLength(0);
    });

    it('reuses the profile on join instead of creating a second one', async () => {
      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: 'reuse-trainer@example.com',
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      await trainers.save(trainers.create({ userId: trainerUser.id, businessName: 'Elite' }));
      const trainerToken = await login('reuse-trainer@example.com', FACTORY_PASSWORD);

      const parent = await ctx.registerVerifiedPlayer({ email: 'reuse-player@example.com' });
      const parentToken = await login(parent.email, parent.password);
      const before = await selfProfileOf(parent.userId);

      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainerToken))
        .send({})
        .expect(201);
      const joined = await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(parentToken))
        .send({})
        .expect(200);

      // requireSelfProfile finds the existing row rather than adding another.
      expect(joined.body.playerProfileId).toBe(before!.id);
      expect(
        await ctx.dataSource
          .getRepository(PlayerProfile)
          .count({ where: { ownerUserId: parent.userId } }),
      ).toBe(1);
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
      expect(profile!.birthDate).toBe(ADULT_DOB);
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
        birthDate: ADULT_DOB,
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
