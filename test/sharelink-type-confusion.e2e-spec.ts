import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Player joins and coach invites redeem out of the same share_links table. The
 * player-side paths never checked the link type, so a coach's single-use,
 * 7-day invite could be spent by anyone who got hold of the code.
 */
describe('ShareLink type confusion and single-use races (e2e)', () => {
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

  const makeTrainer = async (
    email: string,
    businessName: string,
  ): Promise<{ token: string; trainerProfileId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await repo.save(repo.create({ userId: user.id, businessName }));
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return { token: login.body.accessToken as string, trainerProfileId: profile.id };
  };

  const coachInvite = async (token: string, email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/coaches/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send({ email })
      .expect(201);
    return res.body.code as string;
  };

  const playerLink = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    return res.body.code as string;
  };

  const useCountOf = async (code: string): Promise<number> => {
    const row = await ctx.dataSource.getRepository(ShareLink).findOne({ where: { code } });
    return (row as ShareLink).useCount;
  };

  it('refuses to register a stranger as a player against a coach invite code', async () => {
    const trainer = await makeTrainer('t1@example.com', 'Elite Hoops');
    const code = await coachInvite(trainer.token, 'realcoach@example.com');

    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({ email: 'stranger@example.com', password: 'Str0ng!Passw0rd', firstName: 'Mal' })
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_INVALID));

    // The coach's invite is untouched and still works.
    expect(await useCountOf(code)).toBe(0);
    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: 'C0ach!Passw0rd', firstName: 'Real', lastName: 'Coach' })
      .expect(201);
  });

  it('refuses to let a logged-in player join via a coach invite code', async () => {
    const trainer = await makeTrainer('t2@example.com', 'Elite Hoops');
    const code = await coachInvite(trainer.token, 'coach2@example.com');

    const player = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_INVALID));

    expect(await useCountOf(code)).toBe(0);
  });

  it('refuses to add a child to a trainer via a coach invite code', async () => {
    const trainer = await makeTrainer('t3@example.com', 'Elite Hoops');
    const code = await coachInvite(trainer.token, 'coach3@example.com');

    const parent = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: parent.email, password: parent.password })
      .expect(200);
    const parentToken = login.body.accessToken as string;

    const child = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ displayName: 'Kid One', birthDate: '2015-05-05', gender: 'f' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/players/${child.body.id as string}/trainers/by-code`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ code })
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_INVALID));

    expect(await useCountOf(code)).toBe(0);
  });

  it('refuses to accept a coach invite against a static player link', async () => {
    const trainer = await makeTrainer('t4@example.com', 'Elite Hoops');
    const code = await playerLink(trainer.token);

    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${code}/accept`)
      .send({ password: 'C0ach!Passw0rd', firstName: 'Not', lastName: 'Invited' })
      .expect(404)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SHARE_LINK_INVALID));

    expect(await useCountOf(code)).toBe(0);
  });

  it('does not preview a coach invite on the public player join page', async () => {
    const trainer = await makeTrainer('t5@example.com', 'Secret Academy');
    const code = await coachInvite(trainer.token, 'coach5@example.com');

    await request(app.getHttpServer())
      .get(`/api/v1/sharelinks/${code}`)
      .expect(200)
      .expect((r) => {
        expect(r.body.valid).toBe(false);
        expect(r.body.trainer).toBeNull();
      });
  });

  it('refuses to mint a coach-type link through POST /sharelinks', async () => {
    const trainer = await makeTrainer('t6@example.com', 'Elite Hoops');

    await request(app.getHttpServer())
      .post('/api/v1/sharelinks')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ type: ShareLinkType.CoachUnique })
      .expect(422);

    const minted = await ctx.dataSource.getRepository(ShareLink).find();
    expect(minted).toHaveLength(0);
  });

  it('spends a use-limited link exactly once when two different players redeem it concurrently', async () => {
    const trainer = await makeTrainer('t7@example.com', 'Elite Hoops');

    // A use-limited player link is the case where the check-then-act race is
    // genuinely reachable: two *different* accounts redeem it, so unlike the
    // coach-accept path there is no unique email index incidentally
    // serialising them. Only the row lock stops both from passing
    // `useCount < maxUses`.
    const repo = ctx.dataSource.getRepository(ShareLink);
    const link = await repo.save(
      repo.create({
        trainerProfileId: trainer.trainerProfileId,
        code: 'limited-code-1',
        type: ShareLinkType.PlayerStatic,
        targetEmail: null,
        expiresAt: null,
        maxUses: 1,
        useCount: 0,
        active: true,
        createdByUserId: null,
      }),
    );

    const tokenFor = async (): Promise<string> => {
      const player = await ctx.registerVerifiedPlayer();
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: player.email, password: player.password })
        .expect(200);
      return login.body.accessToken as string;
    };
    const [tokenA, tokenB] = [await tokenFor(), await tokenFor()];

    const results = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/join/${link.code}`)
        .set('Authorization', `Bearer ${tokenA}`),
      request(app.getHttpServer())
        .post(`/api/v1/join/${link.code}`)
        .set('Authorization', `Bearer ${tokenB}`),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(410);
    expect(await useCountOf(link.code)).toBe(1);
  });

  it('still lets a static player link be used repeatedly', async () => {
    const trainer = await makeTrainer('t8@example.com', 'Open Gym');
    const code = await playerLink(trainer.token);

    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({ email: 'p1@example.com', password: 'Str0ng!Passw0rd', firstName: 'P' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/join/${code}/register`)
      .send({ email: 'p2@example.com', password: 'Str0ng!Passw0rd', firstName: 'Q' })
      .expect(201);

    expect(await useCountOf(code)).toBe(2);
  });
});
