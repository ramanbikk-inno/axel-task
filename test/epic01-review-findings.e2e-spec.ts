import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { ShareLink, ShareLinkType } from '../src/modules/enrollment/entities/share-link.entity';
import {
  AssociationStatus,
  TrainerPlayerAssociation,
} from '../src/modules/enrollment/entities/trainer-player-association.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

/**
 * Regressions for the defects the review of 37b8d24 confirmed. Each block states
 * the behaviour the code is supposed to have; a failure here is the defect, not
 * a broken test.
 */
describe('Epic-01 review findings (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const COACH_PASSWORD = 'C0ach!Passw0rd';
  const CHILD_PASSWORD = 'K1dSafe!Passw0rd';
  const TRAINER_PASSWORD = 'Tr41ner!Passw0rd';

  // 2026-09-07 is a Monday, so dayOfWeek 1 on both sides of the check.
  const MONDAY_17 = '2026-09-07T17:00:00.000Z';
  const MONDAY_19 = '2026-09-07T19:00:00.000Z';
  // The case that breaks: an evening session that ends exactly at midnight UTC.
  // 22:00-00:00 UTC is 5pm-7pm US Eastern, i.e. the ordinary case for this product.
  const MONDAY_22 = '2026-09-07T22:00:00.000Z';
  const TUESDAY_00 = '2026-09-08T00:00:00.000Z';
  const MONDAY_10 = '2026-09-07T10:00:00.000Z';

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

  interface Trainer {
    userId: string;
    profileId: string;
    token: string;
    code: string;
  }

  const seedTrainer = async (code: string): Promise<Trainer> => {
    const users = ctx.dataSource.getRepository(User);
    const owner = await users.save(
      users.create({
        email: `${code}@example.com`,
        role: Role.Trainer,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
        tokenVersion: 0,
        firstName: 'Terry',
        lastName: 'Trainer',
        passwordHash: await ctx.passwords.hash(TRAINER_PASSWORD),
      }),
    );
    const trainers = ctx.dataSource.getRepository(TrainerProfile);
    const profile = await trainers.save(
      trainers.create({ userId: owner.id, businessName: 'Elite Basketball Academy' }),
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
    return {
      userId: owner.id,
      profileId: profile.id,
      token: await login(`${code}@example.com`, TRAINER_PASSWORD),
      code,
    };
  };

  const inviteCoach = async (trainer: Trainer, email: string): Promise<string> => {
    const invited = await request(app.getHttpServer())
      .post('/api/v1/coaches/invitations')
      .set(auth(trainer.token))
      .send({ email })
      .expect((r) => expect([200, 201]).toContain(r.status));

    await request(app.getHttpServer())
      .post(`/api/v1/coaches/invitations/${invited.body.code}/accept`)
      .send({ password: COACH_PASSWORD, firstName: 'Cody' })
      .expect(201);

    const users = ctx.dataSource.getRepository(User);
    const coachUser = (await users.findOne({ where: { email } })) as User;
    await users.update({ id: coachUser.id }, { emailVerified: true });

    return login(email, COACH_PASSWORD);
  };

  const createEvent = async (
    trainer: Trainer,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string }> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/trainers/me/events')
      .set(auth(trainer.token))
      .send({ title: 'Skills session', startsAt: MONDAY_17, endsAt: MONDAY_19, ...over })
      .expect(201);
    return res.body;
  };

  const coachProfileIdOf = async (trainer: Trainer): Promise<string> => {
    const coaches = await request(app.getHttpServer())
      .get('/api/v1/coaches')
      .set(auth(trainer.token))
      .expect(200);
    return coaches.body[0].id as string;
  };

  /**
   * weeklyWindowOf() reduces an event to a weekday plus a minute window. An event
   * ending at midnight wraps to minute 0, and the clamp turns that into 1440 -
   * a value both CHECK constraints forbid (end_minute <= 1439), so neither the
   * availability check nor the override insert can accept it.
   */
  describe('an event that ends at midnight UTC', () => {
    it('assigns a coach who stated they are free all day', async () => {
      const trainer = await seedTrainer('mid1');
      const coachToken = await inviteCoach(trainer, 'midcoach1@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        // Ranges are half-open, so a whole day ends at the 24:00 boundary.
        // '23:59' would stop at 23:58:59 and miss the event's final minute.
        .send({ slots: [{ dayOfWeek: 1, startTime: '00:00', endTime: '24:00' }] })
        .expect(200);

      const event = await createEvent(trainer, { startsAt: MONDAY_22, endsAt: TUESDAY_00 });
      const coachProfileId = await coachProfileIdOf(trainer);

      const assigned = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId })
        .expect(201);

      expect(assigned.body).toMatchObject({ eventId: event.id, hadConflict: false });
    });

    it('takes the override the 409 told the trainer to send', async () => {
      const trainer = await seedTrainer('mid2');
      const coachToken = await inviteCoach(trainer, 'midcoach2@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] })
        .expect(200);

      const event = await createEvent(trainer, { startsAt: MONDAY_22, endsAt: TUESDAY_00 });
      const coachProfileId = await coachProfileIdOf(trainer);

      // Genuinely unavailable here, so the warning is correct.
      await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId })
        .expect(409);

      // Doing exactly what that response instructs must complete the assignment.
      const assigned = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId, overrideReason: 'Only coach free to cover this week' })
        .expect(201);

      expect(assigned.body.hadConflict).toBe(true);
      expect(assigned.body.overrideId).not.toBeNull();
    });
  });

  /**
   * The case a single {day, start, end} tuple cannot express at all. Collapsing
   * it to one dropped the second day from the check entirely, and did so
   * silently - no error, no override, no warning.
   */
  describe('an event that runs past midnight into the next day', () => {
    // Monday 22:00 -> Tuesday 02:00 UTC: two weekday segments.
    const TUESDAY_02 = '2026-09-08T02:00:00.000Z';

    it('checks the next day too, and warns when the coach is busy there', async () => {
      const trainer = await seedTrainer('span1');
      const coachToken = await inviteCoach(trainer, 'spancoach1@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        // Free for the Monday piece, nothing stated for Tuesday.
        .send({ slots: [{ dayOfWeek: 1, startTime: '20:00', endTime: '24:00' }] })
        .expect(200);

      const event = await createEvent(trainer, { startsAt: MONDAY_22, endsAt: TUESDAY_02 });
      const coachProfileId = await coachProfileIdOf(trainer);

      const refused = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId })
        .expect(409);

      expect(refused.body.errorCode).toBe(ErrorCode.COACH_UNAVAILABLE);
      // Only the Tuesday piece conflicts, so only it is named.
      expect(refused.body.message).toContain('00:00-02:00');
    });

    it('assigns when the coach is free on both days', async () => {
      const trainer = await seedTrainer('span2');
      const coachToken = await inviteCoach(trainer, 'spancoach2@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({
          slots: [
            { dayOfWeek: 1, startTime: '20:00', endTime: '24:00' },
            { dayOfWeek: 2, startTime: '00:00', endTime: '06:00' },
          ],
        })
        .expect(200);

      const event = await createEvent(trainer, { startsAt: MONDAY_22, endsAt: TUESDAY_02 });
      const coachProfileId = await coachProfileIdOf(trainer);

      const assigned = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId })
        .expect(201);

      expect(assigned.body).toMatchObject({ hadConflict: false, overrideId: null });
    });

    it('records an override for every day that conflicted', async () => {
      const trainer = await seedTrainer('span3');
      const coachToken = await inviteCoach(trainer, 'spancoach3@example.com');
      // Free on neither piece, so both segments conflict.
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 3, startTime: '09:00', endTime: '12:00' }] })
        .expect(200);

      const event = await createEvent(trainer, { startsAt: MONDAY_22, endsAt: TUESDAY_02 });
      const coachProfileId = await coachProfileIdOf(trainer);

      await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId, overrideReason: 'Overnight camp cover' })
        .expect(201);

      const overrides = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides')
        .set(auth(trainer.token))
        .expect(200);

      const forEvent = overrides.body.items.filter(
        (o: { eventId: string }) => o.eventId === event.id,
      );
      expect(forEvent).toHaveLength(2);
      expect(forEvent.map((o: { dayOfWeek: number }) => o.dayOfWeek).sort()).toEqual([1, 2]);
    });

    /**
     * An event long enough to span more than two days cannot be expressed in a
     * weekly schedule at all, so it is refused rather than silently half-checked.
     */
    it('refuses an event longer than 24 hours', async () => {
      const trainer = await seedTrainer('span4');
      const res = await request(app.getHttpServer())
        .post('/api/v1/trainers/me/events')
        .set(auth(trainer.token))
        .send({
          title: 'Three day camp',
          startsAt: '2026-09-07T10:00:00.000Z',
          endsAt: '2026-09-09T12:00:00.000Z',
        })
        .expect(400);

      expect(res.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('accepts an event of exactly 24 hours', async () => {
      // The cap is inclusive: 24h is the longest span still expressible in at
      // most two weekday segments.
      const trainer = await seedTrainer('span5');
      await request(app.getHttpServer())
        .post('/api/v1/trainers/me/events')
        .set(auth(trainer.token))
        .send({
          title: 'Full day',
          startsAt: `${MONDAY_10}`,
          endsAt: '2026-09-08T10:00:00.000Z',
        })
        .expect(201);
    });

    it('refuses an event one minute over the cap', async () => {
      const trainer = await seedTrainer('span6');
      const res = await request(app.getHttpServer())
        .post('/api/v1/trainers/me/events')
        .set(auth(trainer.token))
        .send({
          title: 'Just too long',
          startsAt: `${MONDAY_10}`,
          endsAt: '2026-09-08T10:01:00.000Z',
        })
        .expect(400);

      expect(res.body.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  /**
   * 24:00 is the exclusive end of a day, so it is meaningful as an end and
   * meaningless as a start. The two patterns have to stay distinct.
   */
  describe('the 24:00 boundary is an end, not a start', () => {
    it('accepts a window ending at 24:00', async () => {
      const trainer = await seedTrainer('bnd1');
      const coachToken = await inviteCoach(trainer, 'bndcoach1@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '22:00', endTime: '24:00' }] })
        .expect(200);
    });

    it('refuses a window starting at 24:00', async () => {
      const trainer = await seedTrainer('bnd2');
      const coachToken = await inviteCoach(trainer, 'bndcoach2@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '24:00', endTime: '24:00' }] })
        .expect(422);
    });

    it('refuses an hour above 24', async () => {
      const trainer = await seedTrainer('bnd3');
      const coachToken = await inviteCoach(trainer, 'bndcoach3@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '22:00', endTime: '25:00' }] })
        .expect(422);
    });

    it('refuses 24:00 with a non-zero minute', async () => {
      const trainer = await seedTrainer('bnd4');
      const coachToken = await inviteCoach(trainer, 'bndcoach4@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '22:00', endTime: '24:30' }] })
        .expect(422);
    });
  });

  describe('purchase approvals', () => {
    interface Family {
      parentToken: string;
      childToken: string;
      childProfileId: string;
      trainer: Trainer;
    }

    const seedFamily = async (code: string): Promise<Family> => {
      const trainer = await seedTrainer(code);
      const parent = await ctx.registerVerifiedPlayer({ email: `${code}parent@example.com` });
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
        .send({ email: `${code}child@example.com`, password: CHILD_PASSWORD })
        .expect(201);

      // A child may only transact against the organisation they belong to, so
      // the association is part of the setup rather than incidental to it.
      const associations = ctx.dataSource.getRepository(TrainerPlayerAssociation);
      await associations.save(
        associations.create({
          trainerProfileId: trainer.profileId,
          playerProfileId: childProfileId,
          status: AssociationStatus.Active,
          connectedAt: new Date(),
        }),
      );

      return {
        parentToken,
        childToken: await login(`${code}child@example.com`, CHILD_PASSWORD),
        childProfileId,
        trainer,
      };
    };

    /**
     * The event id is caller-supplied and resolved unscoped, so nothing ties it
     * to an organisation the child belongs to.
     */
    it('refuses a request naming another organisation’s event', async () => {
      const fam = await seedFamily('xten');
      const other = await seedTrainer('xtenother');
      const foreign = await createEvent(other, { title: 'Rival academy camp', priceCents: 9900 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: foreign.id, paymentType: 'usd' })
        .expect(404);

      expect(res.body.errorCode).toBe(ErrorCode.EVENT_NOT_FOUND);
    });

    it('does not disclose the foreign event to the child or the parent', async () => {
      const fam = await seedFamily('xten2');
      const other = await seedTrainer('xten2other');
      const foreign = await createEvent(other, { title: 'Rival academy camp', priceCents: 9900 });

      await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: foreign.id, paymentType: 'usd' });

      const mine = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals/mine')
        .set(auth(fam.childToken))
        .expect(200);
      expect(mine.body).toHaveLength(0);

      const queue = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals')
        .set(auth(fam.parentToken))
        .expect(200);
      expect(JSON.stringify(queue.body)).not.toContain('Rival academy camp');
    });

    /**
     * autoApproved is computed, not stored, and only the create response passes
     * the real value - so a spend that bypassed the parent reads back on the
     * parent's own queue as one they granted.
     */
    it('still reports autoApproved on later reads, not just at create', async () => {
      const fam = await seedFamily('auto1');
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.parentToken))
        .send({ allowChildTokenSpendNoApproval: true })
        .expect(200);

      const event = await createEvent(fam.trainer, { priceTokens: 2 });
      const created = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'tokens' })
        .expect(201);
      expect(created.body.autoApproved).toBe(true);

      const parentQueue = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals')
        .set(auth(fam.parentToken))
        .expect(200);
      expect(parentQueue.body[0]).toMatchObject({ status: 'approved', autoApproved: true });

      const childList = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals/mine')
        .set(auth(fam.childToken))
        .expect(200);
      expect(childList.body[0].autoApproved).toBe(true);
    });

    /**
     * The flag is now a stored column, so it has to stay false for a request the
     * parent actually answered - the sibling read path that was previously
     * correct only because it hardcoded false.
     */
    it('distinguishes a parent-approved spend from an auto-approved one', async () => {
      const fam = await seedFamily('auto2');
      const usd = await createEvent(fam.trainer, { priceCents: 2500 });

      const answered = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: usd.id, paymentType: 'usd' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${answered.body.id}/approve`)
        .set(auth(fam.parentToken))
        .send({})
        .expect(200);

      // Now let a token spend through on the standing permission.
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.parentToken))
        .send({ allowChildTokenSpendNoApproval: true })
        .expect(200);
      const tokens = await createEvent(fam.trainer, { priceTokens: 2 });
      await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: tokens.id, paymentType: 'tokens' })
        .expect(201);

      const queue = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals')
        .set(auth(fam.parentToken))
        .expect(200);

      // Both approved, but only one bypassed the parent.
      const byEvent = new Map<string, boolean>(
        queue.body.map((r: { eventId: string; autoApproved: boolean }) => [
          r.eventId,
          r.autoApproved,
        ]),
      );
      expect(byEvent.get(usd.id)).toBe(false);
      expect(byEvent.get(tokens.id)).toBe(true);
    });

    /**
     * The decision response itself goes through decorate(), the path that used
     * to hardcode the flag.
     */
    it('reports autoApproved false on the approve response', async () => {
      const fam = await seedFamily('auto3');
      const event = await createEvent(fam.trainer, { priceCents: 1500 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/approve`)
        .set(auth(fam.parentToken))
        .send({})
        .expect(200);

      expect(approved.body).toMatchObject({ status: 'approved', autoApproved: false });
    });

    /**
     * request() checks for an open row without settling expiry first, so a lapsed
     * request keeps blocking until someone else happens to read the queue.
     */
    it('lets the child ask again once the previous request has lapsed', async () => {
      const fam = await seedFamily('lapse');
      const event = await createEvent(fam.trainer, { priceCents: 2500 });

      await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      // Past the 48-hour window, with nobody having opened the parent's queue.
      ctx.clock.advance(49 * 60 * 60 * 1000);

      const again = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      expect(again.body.status).toBe('pending');
    });
  });
});
