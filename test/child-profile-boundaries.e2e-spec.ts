import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { ErrorCode } from '../src/shared/errors/error-codes';

/** A child carries Role.PlayerParent, so @Roles alone admits it to these routes. */
describe('Child login against the self-profile routes (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const CHILD_PASSWORD = 'K1dSafe!Passw0rd';
  const CHILD_EMAIL = 'kid@example.com';

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

  interface Family {
    parentToken: string;
    parentUserId: string;
    childToken: string;
    childProfileId: string;
  }

  const seedFamily = async (): Promise<Family> => {
    const parent = await ctx.registerVerifiedPlayer({ email: 'parent@example.com' });
    const parentToken = await login(parent.email, parent.password);

    const child = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(parentToken))
      .send({ displayName: 'Maya', birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    const childProfileId = child.body.id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/players/children/${childProfileId}/login`)
      .set(auth(parentToken))
      .send({ email: CHILD_EMAIL, password: CHILD_PASSWORD })
      .expect(201);

    return {
      parentToken,
      parentUserId: parent.userId,
      childToken: await login(CHILD_EMAIL, CHILD_PASSWORD),
      childProfileId,
    };
  };

  const profileCount = (): Promise<number> => ctx.dataSource.getRepository(PlayerProfile).count();

  describe('PATCH /profile/me/player', () => {
    it('refuses a child rather than minting a profile for them', async () => {
      const fam = await seedFamily();
      const before = await profileCount();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.childToken))
        .send({ displayName: 'Definitely An Adult' })
        .expect(403);

      expect(res.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED);
      expect(await profileCount()).toBe(before);
    });

    it('will not let a child assert an adult birth date', async () => {
      const fam = await seedFamily();

      // The floor would force any accepted date to be 18+, so allowing this at
      // all hands the minor a row that says they are an adult.
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.childToken))
        .send({ birthDate: '1990-01-01' })
        .expect(403);

      const owned = await ctx.dataSource
        .getRepository(PlayerProfile)
        .find({ where: { isChild: false } });
      // Only the parent's own profile should be non-child in this family.
      expect(owned).toHaveLength(1);
      expect(owned[0].ownerUserId).toBe(fam.parentUserId);
    });

    it('leaves the child’s real profile untouched', async () => {
      const fam = await seedFamily();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.childToken))
        .send({ birthDate: '1990-01-01', school: 'Nowhere' })
        .expect(403);

      const real = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ id: fam.childProfileId });
      expect(real).toMatchObject({ birthDate: '2014-08-01', school: null, isChild: true });
    });

    it('refuses a child even when the parent already has a self profile', async () => {
      const fam = await seedFamily();
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.parentToken))
        .send({ school: 'Riverside High' })
        .expect(200);

      // The child must not be able to edit the parent's row either, which is
      // what keying on the caller's own userId would otherwise invite.
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.childToken))
        .send({ school: 'Nowhere' })
        .expect(403);

      const parentProfile = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOneBy({ ownerUserId: fam.parentUserId, isChild: false });
      expect(parentProfile!.school).toBe('Riverside High');
    });

    it('still works for the parent', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me/player')
        .set(auth(fam.parentToken))
        .send({ birthDate: '1990-06-15' })
        .expect(200);
      expect(res.body.player.birthDate).toBe('1990-06-15');
    });
  });

  describe('what a child may still do', () => {
    // The invariant worth holding: reading must not conjure a second, non-child profile.
    const expectNoSelfProfileConjured = async (childUserId: string): Promise<void> => {
      const selfRows = await ctx.dataSource
        .getRepository(PlayerProfile)
        .findBy({ ownerUserId: childUserId, isChild: false });
      expect(selfRows).toHaveLength(0);
    };

    it('reads its own account through GET /profile/me', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .get('/api/v1/profile/me')
        .set(auth(fam.childToken))
        .expect(200);
      expect(res.body.email).toBe(CHILD_EMAIL);
      expect(res.body.player).toMatchObject({ id: fam.childProfileId, isChild: true });
      await expectNoSelfProfileConjured(res.body.id as string);
    });

    it('edits its own name', async () => {
      const fam = await seedFamily();

      // Blocking the trainee-profile route must not take the ordinary account
      // fields with it. The phone is the exception — see the sibling case below.
      const res = await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(fam.childToken))
        .send({ firstName: 'Maya', lastName: 'Smith' })
        .expect(200);
      expect(res.body).toMatchObject({ firstName: 'Maya', lastName: 'Smith' });
      // The account fields moved; the trainee profile is still the parent's row.
      expect(res.body.player).toMatchObject({ id: fam.childProfileId, isChild: true });
      await expectNoSelfProfileConjured(res.body.id as string);
    });

    it('cannot rewrite the family phone number', async () => {
      const fam = await seedFamily();

      // "Parent owns all contact information for family": a child login shares
      // the parent's contact details, so this is the parent's field to set.
      await request(app.getHttpServer())
        .patch('/api/v1/profile/me')
        .set(auth(fam.childToken))
        .send({ phone: '+1 555 111 2222' })
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED));
    });

    it('sees its own trainer contexts and nothing of the parent’s', async () => {
      const fam = await seedFamily();

      const res = await request(app.getHttpServer())
        .get('/api/v1/players')
        .set(auth(fam.childToken))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: fam.childProfileId, isChild: true });
    });
  });

  describe('the trainer-side route is closed to a child too', () => {
    it('refuses PATCH /profile/me/trainer', async () => {
      const fam = await seedFamily();

      await request(app.getHttpServer())
        .patch('/api/v1/profile/me/trainer')
        .set(auth(fam.childToken))
        .send({ businessName: 'Kid Corp' })
        .expect(403);
    });
  });
});
