import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { bootstrapE2E, E2EContext } from './setup-e2e';
import { CoachProfile, CoachStatus } from '../src/modules/coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Who may read an organisation's staff list, and which coaches appear on it.
 *
 * "Public" means public *to the organisation*. The endpoint was authenticated
 * but unscoped, so any logged-in account — including a competing trainer —
 * could read any org's coaches from its id. Authentication is not a boundary.
 */
describe('Coach public visibility and its tenancy boundary (e2e)', () => {
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

  interface Org {
    token: string;
    trainerProfileId: string;
  }

  const makeOrg = async (email: string, businessName: string): Promise<Org> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName }));
    return { token: await login(email, FACTORY_PASSWORD), trainerProfileId: profile.id };
  };

  const employCoach = async (
    org: Org,
    email: string,
    over: Partial<CoachProfile> = {},
  ): Promise<{ token: string; coachProfileId: string }> => {
    const user = await createUser(ctx.dataSource, {
      role: Role.Coach,
      email,
      firstName: 'Cathy',
      lastName: 'Coach',
    });
    const repo = ctx.dataSource.getRepository(CoachProfile);
    const profile = await repo.save(
      repo.create({
        userId: user.id,
        trainerProfileId: org.trainerProfileId,
        joinedAt: new Date(),
        publicVisible: true,
        status: CoachStatus.Active,
        bio: 'Ten years with the academy',
        credentials: 'UEFA A Licence',
        certifications: 'Safeguarding, first aid',
        ...over,
      }),
    );
    return { token: await login(email, FACTORY_PASSWORD), coachProfileId: profile.id };
  };

  /** Join a parent account to an organisation, which is what makes them a member. */
  const joinOrg = async (org: Org, token: string): Promise<string> => {
    const link = await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set(auth(org.token))
      .send({})
      .expect(201);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/join/${link.body.code as string}`)
      .set(auth(token))
      .send({})
      .expect(200);
    return joined.body.playerProfileId as string;
  };

  const makeMemberParent = async (org: Org, email: string): Promise<string> => {
    const parent = await ctx.registerVerifiedPlayer({ email });
    const token = await login(parent.email, parent.password);
    await joinOrg(org, token);
    return token;
  };

  describe('who may read the list', () => {
    it('shows it to a parent associated with the organisation', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');
      const member = await makeMemberParent(org, 'member@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(member))
        .expect(200);
      expect(res.body).toHaveLength(1);
    });

    it('shows it to the trainer who owns the organisation', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(org.token))
        .expect(200);
      expect(res.body).toHaveLength(1);
    });

    it('shows it to a coach employed there — including themselves', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      const coach = await employCoach(org, 'coach-a@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(coach.token))
        .expect(200);
      expect(res.body[0].id).toBe(coach.coachProfileId);
    });

    it('hides it from a logged-in parent with no association to the organisation', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');
      const outsider = await ctx.registerVerifiedPlayer({ email: 'outsider@example.com' });
      const token = await login(outsider.email, outsider.password);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(token))
        .expect(404);
      // 404, not 403: the reply must not confirm the id names a real org.
      expect(res.body.errorCode).toBe(ErrorCode.NOT_FOUND);
    });

    it('hides it from a competing trainer', async () => {
      const orgA = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(orgA, 'coach-a@example.com');
      const orgB = await makeOrg('org-b@example.com', 'Org B');

      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${orgA.trainerProfileId}`)
        .set(auth(orgB.token))
        .expect(404);
    });

    it('hides it from a coach employed by a different trainer', async () => {
      const orgA = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(orgA, 'coach-a@example.com');
      const orgB = await makeOrg('org-b@example.com', 'Org B');
      const rival = await employCoach(orgB, 'coach-b@example.com');

      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${orgA.trainerProfileId}`)
        .set(auth(rival.token))
        .expect(404);
    });

    it('stops showing it to a parent whose association has been deactivated', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');
      const parent = await ctx.registerVerifiedPlayer({ email: 'leaver@example.com' });
      const token = await login(parent.email, parent.password);
      const profileId = await joinOrg(org, token);

      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(token))
        .expect(200);

      // The trainer off-boards them; membership ends with the association.
      await request(app.getHttpServer())
        .delete(`/api/v1/trainers/me/roster/${profileId}`)
        .set(auth(org.token))
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(token))
        .expect(404);
    });

    it('stops showing it to a coach whose engagement has ended', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      const coach = await employCoach(org, 'coach-a@example.com');
      const other = await employCoach(org, 'coach-b@example.com');

      await request(app.getHttpServer())
        .delete(`/api/v1/coaches/${coach.coachProfileId}`)
        .set(auth(org.token))
        .expect(200);

      // Off-boarding revokes their sessions outright, so the token they held is
      // refused before tenancy is even consulted.
      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(coach.token))
        .expect(401);

      // A fresh login is the case that actually exercises the membership check:
      // the account still works, but `trainerOrgId` resolves to null once the
      // engagement is Inactive, so their former employer is no longer theirs.
      const readmitted = await login('coach-a@example.com', FACTORY_PASSWORD);
      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(readmitted))
        .expect(404);

      // ...and the colleague still sees the org, minus the departed coach.
      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(other.token))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(other.coachProfileId);
    });

    it('rejects an anonymous caller', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');

      await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .expect(401);
    });

    it('reports an organisation that does not exist the same way as one you are outside of', async () => {
      const outsider = await ctx.registerVerifiedPlayer({ email: 'outsider@example.com' });
      const token = await login(outsider.email, outsider.password);

      const missing = await request(app.getHttpServer())
        .get('/api/v1/coaches/public/00000000-0000-4000-8000-000000000000')
        .set(auth(token))
        .expect(404);

      const org = await makeOrg('org-a@example.com', 'Org A');
      const foreign = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(token))
        .expect(404);

      // Byte-identical but for the per-request fields, or the pair becomes an
      // oracle for which trainer ids are real.
      const shape = (b: Record<string, unknown>): Record<string, unknown> => ({
        statusCode: b.statusCode,
        error: b.error,
        errorCode: b.errorCode,
        message: b.message,
      });
      expect(shape(missing.body)).toEqual(shape(foreign.body));
    });
  });

  describe('which coaches appear', () => {
    it('omits a coach who has not opted in', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'hidden@example.com', { publicVisible: false });
      const member = await makeMemberParent(org, 'member@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(member))
        .expect(200);
      expect(res.body).toHaveLength(0);
    });

    it('omits an off-boarded coach even when they had opted in', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'gone@example.com', {
        publicVisible: true,
        status: CoachStatus.Inactive,
        // A CHECK constraint ties the two together, so an off-boarded row must
        // carry the date the engagement ended.
        endedAt: new Date(),
      });
      const member = await makeMemberParent(org, 'member@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(member))
        .expect(200);
      expect(res.body).toHaveLength(0);
    });

    it('never leaks a coach from another organisation into the list', async () => {
      const orgA = await makeOrg('org-a@example.com', 'Org A');
      const mine = await employCoach(orgA, 'coach-a@example.com');
      const orgB = await makeOrg('org-b@example.com', 'Org B');
      await employCoach(orgB, 'coach-b@example.com');
      const member = await makeMemberParent(orgA, 'member@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${orgA.trainerProfileId}`)
        .set(auth(member))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(mine.coachProfileId);
    });

    it('exposes only the public projection — no email, no employment dates', async () => {
      const org = await makeOrg('org-a@example.com', 'Org A');
      await employCoach(org, 'coach-a@example.com');
      const member = await makeMemberParent(org, 'member@example.com');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${org.trainerProfileId}`)
        .set(auth(member))
        .expect(200);

      expect(Object.keys(res.body[0]).sort()).toEqual([
        'bio',
        'certifications',
        'credentials',
        'firstName',
        'id',
        'lastName',
      ]);
    });
  });
});
