import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { CoachProfile } from '../src/modules/coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Fields and actions the spec asks for that had columns but no reachable API.
 * Each of these was writable only by editing the database directly, or not at
 * all — so none of them could be demonstrated against the running service.
 */
describe('API surface gaps (e2e)', () => {
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
    ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/logo.png', publicId: 'logos/x' });
    ctx.storage.delete.mockResolvedValue(undefined);
  });

  const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeTrainer = async (
    email: string,
  ): Promise<{ token: string; userId: string; trainerProfileId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName: 'Elite Soccer' }));
    return {
      token: await login(email, FACTORY_PASSWORD),
      userId: user.id,
      trainerProfileId: profile.id,
    };
  };

  const makeParentWithChild = async (
    email: string,
  ): Promise<{ token: string; userId: string; childProfileId: string }> => {
    const parent = await ctx.registerVerifiedPlayer({ email });
    const token = await login(parent.email, parent.password);
    const child = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(token))
      .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    return { token, userId: parent.userId, childProfileId: child.body.id as string };
  };

  describe('child profile is no longer write-once', () => {
    it('amends the fields a parent can get wrong at creation', async () => {
      const fam = await makeParentWithChild('patch-child@example.com');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ displayName: 'Alexandra', school: 'Oakwood High', jerseyNumber: '11' })
        .expect(200);

      expect(res.body).toMatchObject({
        displayName: 'Alexandra',
        school: 'Oakwood High',
        jerseyNumber: '11',
      });
    });

    it('reaches emergency_contact, which no request DTO previously carried', async () => {
      const fam = await makeParentWithChild('patch-emergency@example.com');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({
          emergencyContact: { name: 'Gran', phone: '+1 555 000 1111', relationship: 'Grandmother' },
        })
        .expect(200);

      expect(res.body.emergencyContact).toMatchObject({
        name: 'Gran',
        relationship: 'Grandmother',
      });
    });

    it('leaves untouched fields alone rather than blanking them', async () => {
      const fam = await makeParentWithChild('patch-partial@example.com');
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ school: 'Oakwood High' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ jerseyNumber: '7' })
        .expect(200);

      expect(res.body.school).toBe('Oakwood High');
      expect(res.body.displayName).toBe('Alex');
    });

    it('accepts an explicit null as a clear', async () => {
      const fam = await makeParentWithChild('patch-clear@example.com');
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ school: 'Oakwood High' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ school: null })
        .expect(200);

      expect(res.body.school).toBeNull();
    });

    it('keeps the 1-18 bound when the birth date moves', async () => {
      const fam = await makeParentWithChild('patch-age@example.com');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ birthDate: '1980-01-01' })
        .expect(400);

      expect(res.body.errorCode).toBe(ErrorCode.CHILD_AGE_INVALID);
    });

    it('will not let a rename collide with a sibling', async () => {
      const fam = await makeParentWithChild('patch-dupe@example.com');
      await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(fam.token))
        .send({ displayName: 'Maya', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);

      // Renaming to a sibling's name with the same birth date would otherwise be
      // a way round the duplicate rule that create() enforces.
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ displayName: 'Maya' })
        .expect(409);
    });

    it('refuses another family’s child', async () => {
      const mine = await makeParentWithChild('patch-mine@example.com');
      const theirs = await makeParentWithChild('patch-theirs@example.com');

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${theirs.childProfileId}`)
        .set(auth(mine.token))
        .send({ displayName: 'Hijacked' })
        .expect(404);
    });

    it('routes the account holder’s own profile to /profile/me instead', async () => {
      const trainer = await makeTrainer('patch-self-trainer@example.com');
      const parent = await ctx.registerVerifiedPlayer({ email: 'patch-self@example.com' });
      const token = await login(parent.email, parent.password);
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);
      const joined = await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(token))
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${joined.body.playerProfileId as string}`)
        .set(auth(token))
        .send({ displayName: 'Nope' })
        .expect(400);
    });
  });

  describe('skill level is now the trainer’s to set', () => {
    const seedRoster = async (
      prefix: string,
    ): Promise<{ trainer: { token: string; trainerProfileId: string }; profileId: string }> => {
      const trainer = await makeTrainer(`${prefix}-trainer@example.com`);
      const parent = await ctx.registerVerifiedPlayer({ email: `${prefix}-player@example.com` });
      const token = await login(parent.email, parent.password);
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);
      const joined = await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(token))
        .send({})
        .expect(200);
      return { trainer, profileId: joined.body.playerProfileId as string };
    };

    it('records the assessment and reports it on the roster', async () => {
      const { trainer, profileId } = await seedRoster('skill');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainer.token))
        .send({ skillLevel: 'Intermediate' })
        .expect(200);

      expect(res.body).toMatchObject({ playerProfileId: profileId, skillLevel: 'Intermediate' });

      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainer.token))
        .expect(200);
      expect(roster.body[0].skillLevel).toBe('Intermediate');
    });

    it('clears the assessment on null', async () => {
      const { trainer, profileId } = await seedRoster('skill-clear');
      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainer.token))
        .send({ skillLevel: 'Elite' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainer.token))
        .send({ skillLevel: null })
        .expect(200);
      expect(res.body.skillLevel).toBeNull();
    });

    it('reports a player outside the caller’s organisation as not on the roster', async () => {
      const { profileId } = await seedRoster('skill-tenancy');
      const stranger = await makeTrainer('skill-stranger@example.com');

      // 404 rather than 403: a 403 would confirm the id names a real profile in
      // somebody else's organisation.
      await request(app.getHttpServer())
        .patch(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(stranger.token))
        .send({ skillLevel: 'Elite' })
        .expect(404);
    });

    it('lets a trainer off-board a player, preserving history', async () => {
      const { trainer, profileId } = await seedRoster('roster-remove');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(trainer.token))
        .expect(204);

      const active = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainer.token))
        .expect(200);
      expect(active.body).toHaveLength(0);

      // Soft, like the family-side removal — the pairing survives.
      const all = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .query({ includeInactive: true })
        .set(auth(trainer.token))
        .expect(200);
      expect(all.body).toHaveLength(1);
      expect(all.body[0].status).toBe('inactive');
    });

    it('will not off-board a player from another organisation', async () => {
      const { profileId } = await seedRoster('roster-tenancy');
      const stranger = await makeTrainer('roster-stranger@example.com');

      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(stranger.token))
        .expect(404);
    });
  });

  describe('coach profile fields are readable', () => {
    const seedCoach = async (
      prefix: string,
      publicVisible: boolean,
    ): Promise<{ trainer: { token: string; trainerProfileId: string }; coachToken: string }> => {
      const trainer = await makeTrainer(`${prefix}-trainer@example.com`);
      const coachEmail = `${prefix}-coach@example.com`;
      const coachUser = await createUser(ctx.dataSource, { role: Role.Coach, email: coachEmail });
      const coaches = ctx.dataSource.getRepository(CoachProfile);
      await coaches.save(
        coaches.create({
          userId: coachUser.id,
          trainerProfileId: trainer.trainerProfileId,
          joinedAt: new Date(),
          publicVisible,
        }),
      );
      return { trainer, coachToken: await login(coachEmail, FACTORY_PASSWORD) };
    };

    /**
     * A parent actually inside the trainer's organisation — the audience the
     * public coach list exists for. Merely holding an account is not enough:
     * the list is scoped to members, so the viewer has to join.
     */
    const seedOrgMember = async (prefix: string, trainerToken: string): Promise<string> => {
      const parent = await ctx.registerVerifiedPlayer({ email: `${prefix}-viewer@example.com` });
      const token = await login(parent.email, parent.password);
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainerToken))
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(token))
        .send({})
        .expect(200);
      return token;
    };

    it('returns credentials and certifications the coach just wrote', async () => {
      const { coachToken } = await seedCoach('coach-read', false);

      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(coachToken))
        .send({ bio: 'Ten years coaching.', credentials: 'UEFA B', certifications: 'First Aid' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/coaches/me')
        .set(auth(coachToken))
        .expect(200);

      // Both were accepted by PATCH but omitted from the view, so a coach could
      // not read back what they had saved.
      expect(res.body).toMatchObject({ credentials: 'UEFA B', certifications: 'First Aid' });
    });

    it('lists a coach who opted in, to anyone in the organisation', async () => {
      const { trainer, coachToken } = await seedCoach('coach-public', true);
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(coachToken))
        .send({ bio: 'Ten years coaching.', credentials: 'UEFA B' })
        .expect(200);

      const viewer = await seedOrgMember('coach-public', trainer.token);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${trainer.trainerProfileId}`)
        .set(auth(viewer))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ bio: 'Ten years coaching.', credentials: 'UEFA B' });
      // Narrower than CoachView on purpose: a player has no business seeing the
      // coach's email or employment dates.
      expect(res.body[0].email).toBeUndefined();
      expect(res.body[0].joinedAt).toBeUndefined();
    });

    it('omits a coach who has not opted in — the flag now gates something', async () => {
      const { trainer } = await seedCoach('coach-private', false);
      const viewer = await seedOrgMember('coach-private', trainer.token);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${trainer.trainerProfileId}`)
        .set(auth(viewer))
        .expect(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('minors cannot hold an account in their own name', () => {
    it('rejects an underage self-registration', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'too-young@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: '2015-01-01',
        })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.UNDERAGE_SELF_REGISTRATION);
    });

    it('rejects an underage registration through a ShareLink too', async () => {
      const trainer = await makeTrainer('age-link-trainer@example.com');
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);

      // The second public door onto account creation. A gate on only one of two
      // is not a gate.
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}/register`)
        .send({
          email: 'too-young-link@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: '2015-01-01',
        })
        .expect(403);

      // And it must not have cost the trainer a use of the link.
      const links = await request(app.getHttpServer())
        .get('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .expect(200);
      expect(links.body[0].useCount).toBe(0);
    });

    it('admits an adult', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'old-enough@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: ADULT_DOB,
        })
        .expect(201);
    });

    it('requires birthDate at all, so the rule cannot be skipped by omission', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'no-dob@example.com', password: 'Str0ng!Passw0rd' })
        .expect(422);
    });

    it('rejects a future birth date rather than reading it as age 0', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'future@example.com',
          password: 'Str0ng!Passw0rd',
          birthDate: '2099-01-01',
        })
        .expect(400);
    });

    it('does not leak whether the address is taken when the applicant is underage', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'taken@example.com', password: 'Str0ng!Passw0rd', birthDate: ADULT_DOB })
        .expect(201);

      // Same 403 for a taken address as for a fresh one: the age check runs
      // first, so this endpoint cannot be used to probe for existing accounts.
      const taken = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'taken@example.com', password: 'Str0ng!Passw0rd', birthDate: '2015-01-01' })
        .expect(403);
      const fresh = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'fresh@example.com', password: 'Str0ng!Passw0rd', birthDate: '2015-01-01' })
        .expect(403);

      // requestId and timestamp are per-request by design; everything a caller
      // could distinguish the two cases by must match.
      const distinguishing = (body: Record<string, unknown>): Record<string, unknown> => ({
        statusCode: body.statusCode,
        error: body.error,
        errorCode: body.errorCode,
        message: body.message,
      });
      expect(distinguishing(taken.body)).toEqual(distinguishing(fresh.body));
    });
  });

  describe('smaller reporting gaps', () => {
    it('reports when each trainer association began (“with dates”)', async () => {
      const trainer = await makeTrainer('dates-trainer@example.com');
      const parent = await ctx.registerVerifiedPlayer({ email: 'dates-parent@example.com' });
      const token = await login(parent.email, parent.password);
      const link = await request(app.getHttpServer())
        .post('/api/v1/sharelinks')
        .set(auth(trainer.token))
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/join/${link.body.code as string}`)
        .set(auth(token))
        .send({})
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(token))
        .expect(200);

      const withTrainer = res.body.find((p: { trainers: unknown[] }) => p.trainers.length > 0);
      expect(withTrainer.trainers[0].connectedAt).toBeDefined();
      expect(new Date(withTrainer.trainers[0].connectedAt as string).getTime()).not.toBeNaN();
    });

    it('resets the brand colour to the platform default', async () => {
      const trainer = await makeTrainer('reset-colour@example.com');
      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(trainer.token))
        .send({ primaryColor: '#1e88e5' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(trainer.token))
        .send({ primaryColor: null })
        .expect(200);

      expect(res.body.primaryColor).toBeNull();
    });

    it('still rejects a malformed colour', async () => {
      const trainer = await makeTrainer('bad-colour@example.com');
      await request(app.getHttpServer())
        .patch('/api/v1/trainers/me/branding')
        .set(auth(trainer.token))
        .send({ primaryColor: 'rebeccapurple' })
        .expect(422);
    });
  });

  describe('erasure still reaches the newly-writable fields', () => {
    it('clears an emergency contact set through the new endpoint', async () => {
      const sa = await ctx.seedSuperAdmin();
      const admin = await login(sa.email, sa.password);
      const fam = await makeParentWithChild('erase-emergency@example.com');

      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.token))
        .send({ emergencyContact: { name: 'Gran', phone: '+1 555 000 1111' } })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${fam.userId}`)
        .set(auth(admin))
        .send({ reason: 'Right to erasure.' })
        .expect(200);

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: fam.childProfileId } })) as PlayerProfile;
      expect(profile.emergencyContact).toBeNull();
    });
  });
});
