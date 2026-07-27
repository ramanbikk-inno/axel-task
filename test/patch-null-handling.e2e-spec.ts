import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { bootstrapE2E, E2EContext } from './setup-e2e';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';

/**
 * What every PATCH does with an explicit `null`. Two right answers, fixed by the
 * column: a nullable field clears, a non-nullable one rejects at the pipe. The
 * wrong answer is a 500, which is what `@IsOptional()` plus a `!== undefined`
 * gate produced. Every PATCH is here because the bug is in an idiom, not one
 * endpoint.
 */
describe('Explicit null on every PATCH (e2e)', () => {
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

  const makeParent = async (email = 'parent@example.com'): Promise<string> => {
    const parent = await ctx.registerVerifiedPlayer({ email });
    return login(parent.email, parent.password);
  };

  const makeTrainer = async (email = 'trainer@example.com'): Promise<string> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    await repo.save(repo.create({ userId: user.id, businessName: 'Elite Soccer' }));
    return login(email, FACTORY_PASSWORD);
  };

  const makeCoach = async (email = 'coach@example.com'): Promise<string> => {
    const trainerUser = await createUser(ctx.dataSource, {
      role: Role.Trainer,
      email: `emp-${email}`,
    });
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const org = await trainers.save(
      trainers.create({ userId: trainerUser.id, businessName: 'Elite Soccer' }),
    );
    const coachUser = await createUser(ctx.dataSource, { role: Role.Coach, email });
    const coaches = ctx.dataSource.getRepository(CoachProfile);
    await coaches.save(
      coaches.create({
        userId: coachUser.id,
        trainerProfileId: org.id,
        joinedAt: new Date(),
        publicVisible: true,
      }),
    );
    return login(email, FACTORY_PASSWORD);
  };

  const makeChild = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(token))
      .send({ displayName: 'Maya', birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    return res.body.id as string;
  };

  describe('PATCH /players/children/:profileId', () => {
    it('rejects a null displayName rather than failing in the database', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      // The regression this file exists for: this used to be a 500, because a
      // null slipped past @IsOptional() into a NOT NULL column.
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ displayName: null })
        .expect(422);
    });

    it('leaves the profile untouched after a rejected null', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ displayName: null, school: 'Riverside' })
        .expect(422);

      const res = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(token))
        .expect(200);
      const child = (res.body as Array<Record<string, unknown>>).find((p) => p.id === childId);
      // Not a partial write either: the whole request failed, so `school` from
      // the same body must not have landed.
      expect(child).toMatchObject({ displayName: 'Maya', school: null });
    });

    it('rejects a null birthDate — a child profile without an age is not a child profile', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ birthDate: null })
        .expect(422);
    });

    it('rejects a null gender, which creation makes mandatory', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      // POST /players/children will not accept a profile without a gender, so
      // PATCH must not be a way to end up with one.
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ gender: null })
        .expect(422);
    });

    it('accepts a null school and jerseyNumber, which is how a parent clears them', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ school: 'Riverside High', jerseyNumber: '10' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ school: null, jerseyNumber: null })
        .expect(200);
      expect(res.body).toMatchObject({ school: null, jerseyNumber: null });
    });

    it('accepts a null emergencyContact, clearing third-party PII on request', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ emergencyContact: { name: 'Jane Smith', phone: '+1 555 123 4567' } })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ emergencyContact: null })
        .expect(200);
      expect(res.body.emergencyContact).toBeNull();
    });

    it('still accepts an omitted field as "leave it alone"', async () => {
      const token = await makeParent();
      const childId = await makeChild(token);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${childId}`)
        .set(auth(token))
        .send({ school: 'Riverside High' })
        .expect(200);
      // Rejecting null must not have turned every absent key into a required one.
      expect(res.body).toMatchObject({
        displayName: 'Maya',
        gender: 'female',
        birthDate: '2014-08-01',
        school: 'Riverside High',
      });
    });
  });

  describe('PATCH /profile/me/player', () => {
    it('rejects a null displayName rather than failing in the database', async () => {
      const token = await makeParent();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ displayName: 'Sam Player' })
        .expect(200);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ displayName: null })
        .expect(422);
    });

    it('accepts a null school, jerseyNumber and gender', async () => {
      const token = await makeParent();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ displayName: 'Sam', school: 'Riverside', jerseyNumber: '7', gender: 'male' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ school: null, jerseyNumber: null, gender: null })
        .expect(200);
      expect(res.body.player).toMatchObject({ school: null, jerseyNumber: null, gender: null });
    });

    it('accepts a null emergencyContact, clearing third-party PII on request', async () => {
      const token = await makeParent();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ emergencyContact: { name: 'Jane Smith', phone: '+1 555 123 4567' } })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ emergencyContact: null })
        .expect(200);
      expect(res.body.player.emergencyContact).toBeNull();
    });

    it('rejects a null birthDate — the age gate has nothing to check against', async () => {
      const token = await makeParent();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(token))
        .send({ birthDate: null })
        .expect(422);
    });
  });

  describe('PATCH /profile/me/child', () => {
    /** A child login for the parent's child profile, which is what this route edits. */
    const makeChildLogin = async (parentToken: string, childProfileId: string): Promise<string> => {
      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${childProfileId}/login`)
        .set(auth(parentToken))
        .send({ email: 'kid-null@example.com', password: 'K1dSafe!Passw0rd' })
        .expect(201);
      return login('kid-null@example.com', 'K1dSafe!Passw0rd');
    };

    it('accepts a null school and jerseyNumber, which is how a child clears them', async () => {
      const parentToken = await makeParent();
      const childId = await makeChild(parentToken);
      const childToken = await makeChildLogin(parentToken, childId);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(childToken))
        .send({ school: 'Riverside High', jerseyNumber: '23' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(childToken))
        .send({ school: null, jerseyNumber: null })
        .expect(200);
      expect(res.body.player).toMatchObject({ school: null, jerseyNumber: null });
    });

    it('treats an empty body as "change nothing" rather than blanking the profile', async () => {
      const parentToken = await makeParent();
      const childId = await makeChild(parentToken);
      const childToken = await makeChildLogin(parentToken, childId);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(childToken))
        .send({ school: 'Riverside High', jerseyNumber: '23' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(childToken))
        .send({})
        .expect(200);
      expect(res.body.player).toMatchObject({
        school: 'Riverside High',
        jerseyNumber: '23',
        displayName: 'Maya',
        birthDate: '2014-08-01',
      });
    });

    it('rejects a field the child does not own rather than ignoring it', async () => {
      const parentToken = await makeParent();
      const childId = await makeChild(parentToken);
      const childToken = await makeChildLogin(parentToken, childId);

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/child')
        .set(auth(childToken))
        .send({ school: 'Riverside High', gender: null })
        .expect(422);
    });
  });

  describe('PATCH /profile/me/trainer', () => {
    it('rejects a null businessName rather than failing in the database', async () => {
      const token = await makeTrainer();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/trainer')
        .set(auth(token))
        .send({ businessName: null })
        .expect(422);
    });

    it('accepts a null website, address and description', async () => {
      const token = await makeTrainer();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/trainer')
        .set(auth(token))
        .send({ website: 'https://elite.example', address: '1 Main St', description: 'Hi' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/trainer')
        .set(auth(token))
        .send({ website: null, address: null, description: null })
        .expect(200);
      expect(res.body.trainer).toMatchObject({
        website: null,
        address: null,
        description: null,
      });
    });
  });

  describe('PATCH /profile/me', () => {
    it('accepts a null firstName, lastName and phone, which are all nullable', async () => {
      const token = await makeParent();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(token))
        .send({ firstName: 'Sam', lastName: 'Smith', phone: '+1 555 123 4567' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(token))
        .send({ firstName: null, lastName: null, phone: null })
        .expect(200);
      expect(res.body).toMatchObject({ firstName: null, lastName: null, phone: null });
    });
  });

  describe('PATCH /coaches/me', () => {
    it('rejects a null publicVisible rather than failing in the database', async () => {
      const token = await makeCoach();
      // A boolean column with a default, but still NOT NULL — the same hole.
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(token))
        .send({ publicVisible: null })
        .expect(422);
    });

    it('accepts a null bio, credentials and certifications', async () => {
      const token = await makeCoach();
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(token))
        .send({ bio: 'Ten years', credentials: 'UEFA B', certifications: 'First aid' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(token))
        .send({ bio: null, credentials: null, certifications: null })
        .expect(200);
      expect(res.body).toMatchObject({ bio: null, credentials: null, certifications: null });
    });
  });

  describe('PATCH /trainers/me/branding', () => {
    it('accepts a null primaryColor as the documented reset', async () => {
      const token = await makeTrainer();
      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(token))
        .send({ primaryColor: '#1e88e5' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(token))
        .send({ primaryColor: null })
        .expect(200);
      expect(res.body.primaryColor).toBeNull();
    });

    it('still rejects an omitted primaryColor — nullable is not optional', async () => {
      const token = await makeTrainer();
      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(token))
        .send({})
        .expect(422);
    });

    it('still rejects a malformed colour', async () => {
      const token = await makeTrainer();
      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(token))
        .send({ primaryColor: 'rebeccapurple' })
        .expect(422);
    });
  });

  describe('PATCH /trainers/me/roster/:playerProfileId', () => {
    it('accepts a null skillLevel as "no assessment recorded"', async () => {
      const trainerToken = await makeTrainer();
      const parentToken = await makeParent();
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
      const profileId = joined.body.playerProfileId as string;

      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainerToken))
        .send({ skillLevel: 'Elite' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainerToken))
        .send({ skillLevel: null })
        .expect(200);
      expect(res.body.skillLevel).toBeNull();
    });
  });
});
