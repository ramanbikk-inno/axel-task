import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { CampSubmission } from '../src/modules/enrollment/entities/camp-submission.entity';
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
 * The two Epic-01 flows that previously had no route to demo, plus the camp
 * conversion. One block per §10 acceptance criterion they close.
 */
describe('Epic-01 MVP completion (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const COACH_PASSWORD = 'C0ach!Passw0rd';
  const CHILD_PASSWORD = 'K1dSafe!Passw0rd';
  const TRAINER_PASSWORD = 'Tr41ner!Passw0rd';

  // A Monday, so the weekday the availability slots key on is deterministic.
  const MONDAY_17 = '2026-09-07T17:00:00.000Z';
  const MONDAY_19 = '2026-09-07T19:00:00.000Z';

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

    // Accepting mints an unverified account; verification is a separate step
    // and login is gated on it.
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

  // §10 L975 — "Trainer can assign coaches to events (with availability checks)"
  describe('assigning a coach to an event', () => {
    it('assigns without an override when the coach stated they are free', async () => {
      const trainer = await seedTrainer('assign1');
      const coachToken = await inviteCoach(trainer, 'coach1@example.com');
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '16:00', endTime: '20:00' }] })
        .expect(200);

      const event = await createEvent(trainer);
      const coaches = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(trainer.token))
        .expect(200);

      const assigned = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId: coaches.body[0].id })
        .expect(201);

      expect(assigned.body).toMatchObject({
        eventId: event.id,
        hadConflict: false,
        overrideId: null,
        response: 'pending',
      });
    });

    it('warns instead of assigning when the coach is not free, then takes the override', async () => {
      const trainer = await seedTrainer('assign2');
      const coachToken = await inviteCoach(trainer, 'coach2@example.com');
      // Free in the morning only; the event runs 17:00-19:00.
      await request(app.getHttpServer())
        .put('/api/v1/coaches/me/availability')
        .set(auth(coachToken))
        .send({ slots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] })
        .expect(200);

      const event = await createEvent(trainer);
      const coaches = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(trainer.token))
        .expect(200);
      const coachProfileId = coaches.body[0].id as string;

      const refused = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId })
        .expect(409);
      expect(refused.body.errorCode).toBe(ErrorCode.COACH_UNAVAILABLE);
      expect(refused.body.message).toContain('Continue anyway?');

      const assigned = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId, overrideReason: 'Only coach free to cover this week' })
        .expect(201);
      expect(assigned.body.hadConflict).toBe(true);
      expect(assigned.body.overrideId).not.toBeNull();

      // The override is logged against the event, with the reason.
      const overrides = await request(app.getHttpServer())
        .get('/api/v1/coach-overrides')
        .set(auth(trainer.token))
        .expect(200);
      expect(overrides.body.items[0]).toMatchObject({
        eventId: event.id,
        overrideReason: 'Only coach free to cover this week',
        hadConflict: true,
      });
      // And the coach was told, because something was actually overridden.
      expect(ctx.mailer.sendCoachAvailabilityOverride).toHaveBeenCalled();
    });

    it('lets the coach see the assignment and accept it', async () => {
      const trainer = await seedTrainer('assign3');
      const coachToken = await inviteCoach(trainer, 'coach3@example.com');
      const event = await createEvent(trainer);
      const coaches = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(trainer.token))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId: coaches.body[0].id, overrideReason: 'No stated times yet' })
        .expect(201);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/coaches/me/assignments')
        .set(auth(coachToken))
        .expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).toMatchObject({ eventTitle: 'Skills session', response: 'pending' });

      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/coaches/me/assignments/${mine.body[0].id}/accept`)
        .set(auth(coachToken))
        .expect(200);
      expect(accepted.body.response).toBe('accepted');
    });

    it('lets the coach ask for a change without cancelling the assignment', async () => {
      const trainer = await seedTrainer('assign4');
      const coachToken = await inviteCoach(trainer, 'coach4@example.com');
      const event = await createEvent(trainer);
      const coaches = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(trainer.token))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .send({ coachProfileId: coaches.body[0].id, overrideReason: 'Short notice' })
        .expect(201);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/coaches/me/assignments')
        .set(auth(coachToken))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/coaches/me/assignments/${mine.body[0].id}/request-change`)
        .set(auth(coachToken))
        .send({ note: 'Could we start at 18:00?' })
        .expect(200);

      // The trainer still sees the coach on the event — asking is not refusing.
      const onEvent = await request(app.getHttpServer())
        .get(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(trainer.token))
        .expect(200);
      expect(onEvent.body[0]).toMatchObject({
        response: 'change_requested',
        coachNote: 'Could we start at 18:00?',
      });
    });

    it("refuses to assign another organisation's coach", async () => {
      const a = await seedTrainer('assign5a');
      const b = await seedTrainer('assign5b');
      await inviteCoach(b, 'coach5@example.com');
      const bCoaches = await request(app.getHttpServer())
        .get('/api/v1/coaches')
        .set(auth(b.token))
        .expect(200);

      const event = await createEvent(a);
      await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/events/${event.id}/coaches`)
        .set(auth(a.token))
        .send({ coachProfileId: bCoaches.body[0].id, overrideReason: 'x' })
        .expect(404);
    });
  });

  // §10 L960 — "Child purchase requires parent approval workflow complete"
  describe('child purchase approval', () => {
    interface Family {
      parentToken: string;
      childToken: string;
      childProfileId: string;
      trainer: Trainer;
    }

    const seedFamily = async (
      code: string,
      over: Record<string, unknown> = {},
    ): Promise<Family> => {
      const trainer = await seedTrainer(code);
      const parent = await ctx.registerVerifiedPlayer({ email: `${code}parent@example.com` });
      const parentToken = await login(parent.email, parent.password);

      const created = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'male', ...over })
        .expect(201);
      const childProfileId = created.body.id as string;

      await request(app.getHttpServer())
        .post(`/api/v1/players/children/${childProfileId}/login`)
        .set(auth(parentToken))
        .send({ email: `${code}child@example.com`, password: CHILD_PASSWORD })
        .expect(201);

      // A purchase request is scoped to the child's own organisation, so the
      // association has to exist for the child to transact at all.
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

    it('holds a USD request for the parent, who approves it with a note', async () => {
      const fam = await seedFamily('appr1');
      const event = await createEvent(fam.trainer, { priceCents: 2500 });

      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);
      expect(requested.body).toMatchObject({
        status: 'pending',
        amount: 2500,
        autoApproved: false,
      });
      expect(ctx.mailer.sendPurchaseApprovalRequest).toHaveBeenCalled();

      const queue = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals?status=pending')
        .set(auth(fam.parentToken))
        .expect(200);
      expect(queue.body).toHaveLength(1);
      expect(queue.body[0].childDisplayName).toBe('Alex');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/approve`)
        .set(auth(fam.parentToken))
        .send({ notes: 'Have fun' })
        .expect(200);
      expect(approved.body).toMatchObject({ status: 'approved', parentNotes: 'Have fun' });

      // The child sees the answer.
      const mine = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals/mine')
        .set(auth(fam.childToken))
        .expect(200);
      expect(mine.body[0].status).toBe('approved');
      expect(ctx.mailer.sendPurchaseDecision).toHaveBeenCalled();
    });

    it('lets the parent deny with a note', async () => {
      const fam = await seedFamily('appr2');
      const event = await createEvent(fam.trainer, { priceCents: 4000 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      const denied = await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/deny`)
        .set(auth(fam.parentToken))
        .send({ notes: 'Not this week' })
        .expect(200);
      expect(denied.body).toMatchObject({ status: 'denied', parentNotes: 'Not this week' });
    });

    it('holds a token request too while the setting is off (the default)', async () => {
      const fam = await seedFamily('appr3');
      const event = await createEvent(fam.trainer, { priceTokens: 3 });

      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'tokens' })
        .expect(201);
      expect(requested.body).toMatchObject({ status: 'pending', amount: 3, autoApproved: false });
    });

    it('passes a token request straight through once the parent allows it', async () => {
      const fam = await seedFamily('appr4');
      await request(app.getHttpServer())
        .patch(`/api/v1/players/children/${fam.childProfileId}`)
        .set(auth(fam.parentToken))
        .send({ allowChildTokenSpendNoApproval: true })
        .expect(200);

      const event = await createEvent(fam.trainer, { priceTokens: 2 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'tokens' })
        .expect(201);

      expect(requested.body).toMatchObject({ status: 'approved', autoApproved: true });
      // Informational, not a request for approval.
      expect(ctx.mailer.sendChildPurchaseNotice).toHaveBeenCalled();
      expect(ctx.mailer.sendPurchaseApprovalRequest).not.toHaveBeenCalled();
    });

    it('auto-declines a request nobody answered within 48 hours', async () => {
      const fam = await seedFamily('appr5');
      const event = await createEvent(fam.trainer, { priceCents: 1000 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      // Move the clock past the deadline rather than editing the row: the
      // expiry is settled on read, so this is what a request left overnight
      // looks like when the parent finally opens their queue.
      ctx.clock.advance(49 * 60 * 60 * 1000);

      const queue = await request(app.getHttpServer())
        .get('/api/v1/purchase-approvals')
        .set(auth(fam.parentToken))
        .expect(200);
      expect(queue.body[0].status).toBe('expired');

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/approve`)
        .set(auth(fam.parentToken))
        .send({})
        .expect(409)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.APPROVAL_NOT_PENDING));
    });

    it('refuses a child the decision on their own request', async () => {
      const fam = await seedFamily('appr6');
      const event = await createEvent(fam.trainer, { priceCents: 1500 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/approve`)
        .set(auth(fam.childToken))
        .send({})
        .expect(403)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.CHILD_ACTION_NOT_ALLOWED));
    });

    it("refuses another family's request", async () => {
      const fam = await seedFamily('appr7');
      const event = await createEvent(fam.trainer, { priceCents: 1500 });
      const requested = await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send({ eventId: event.id, paymentType: 'usd' })
        .expect(201);

      const stranger = await ctx.registerVerifiedPlayer({ email: 'appr7stranger@example.com' });
      const strangerToken = await login(stranger.email, stranger.password);
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-approvals/${requested.body.id}/approve`)
        .set(auth(strangerToken))
        .send({})
        .expect(404);
    });

    it('refuses a second open request for the same event', async () => {
      const fam = await seedFamily('appr8');
      const event = await createEvent(fam.trainer, { priceCents: 1500 });
      const body = { eventId: event.id, paymentType: 'usd' };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/purchase-approvals')
        .set(auth(fam.childToken))
        .send(body)
        .expect(409);
    });
  });

  // §3 L57 — Camp-to-User Conversion
  describe('camp-to-user conversion', () => {
    const submit = async (trainer: Trainer, email: string): Promise<Record<string, string>> => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/camps/${trainer.code}/submissions`)
        .send({
          firstName: 'Jamie',
          lastName: 'Rivera',
          email,
          phone: '+1 555 010 2020',
          birthDate: '1994-03-22',
          gender: 'female',
        })
        .expect(201);
      return res.body;
    };

    it('captures a form and hands back a pre-fill token', async () => {
      const trainer = await seedTrainer('camp1');
      const submission = await submit(trainer, 'jamie1@example.com');

      expect(submission).toMatchObject({
        firstName: 'Jamie',
        email: 'jamie1@example.com',
        trainerName: 'Elite Basketball Academy',
        converted: false,
      });
      expect(submission.token).toBeTruthy();
    });

    it('serves the pre-fill payload without asking anyone to log in', async () => {
      const trainer = await seedTrainer('camp2');
      const submission = await submit(trainer, 'jamie2@example.com');

      const prefill = await request(app.getHttpServer())
        .get(`/api/v1/camp-submissions/${submission.token}`)
        .expect(200);
      expect(prefill.body).toMatchObject({
        firstName: 'Jamie',
        lastName: 'Rivera',
        phone: '+1 555 010 2020',
        birthDate: '1994-03-22',
        converted: false,
      });
    });

    it('converts with only a password, and auto-assigns the trainer', async () => {
      const trainer = await seedTrainer('camp3');
      const submission = await submit(trainer, 'jamie3@example.com');

      const converted = await request(app.getHttpServer())
        .post(`/api/v1/camp-submissions/${submission.token}/register`)
        .send({ password: 'Str0ng!Passw0rd' })
        .expect(201);
      expect(converted.body.trainerProfileId).toBe(trainer.profileId);

      // Nothing was retyped: the name and phone came from the form.
      const roster = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/roster')
        .set(auth(trainer.token))
        .expect(200);
      expect(roster.body).toHaveLength(1);
      expect(roster.body[0]).toMatchObject({
        accountEmail: 'jamie3@example.com',
        accountName: 'Jamie Rivera',
        accountPhone: '+1 555 010 2020',
      });

      const row = await ctx.dataSource
        .getRepository(CampSubmission)
        .findOneBy({ token: submission.token });
      expect(row?.convertedUserId).not.toBeNull();
    });

    it('refuses to convert the same form twice', async () => {
      const trainer = await seedTrainer('camp4');
      const submission = await submit(trainer, 'jamie4@example.com');
      await request(app.getHttpServer())
        .post(`/api/v1/camp-submissions/${submission.token}/register`)
        .send({ password: 'Str0ng!Passw0rd' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/camp-submissions/${submission.token}/register`)
        .send({ password: 'Str0ng!Passw0rd' })
        .expect(409)
        .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.SUBMISSION_ALREADY_CONVERTED));
    });

    it('lets the trainer see who never came back, and mail them the link', async () => {
      const trainer = await seedTrainer('camp5');
      await submit(trainer, 'jamie5@example.com');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/camp-submissions')
        .set(auth(trainer.token))
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ converted: false, shareLinkSentAt: null });

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/trainers/me/camp-submissions/${listed.body[0].id}/send-sharelink`)
        .set(auth(trainer.token))
        .send({})
        .expect(200);
      expect(sent.body.shareLinkSentAt).not.toBeNull();
      expect(ctx.mailer.sendCampShareLink).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jamie5@example.com',
          trainerName: 'Elite Basketball Academy',
        }),
      );
    });

    it("keeps one trainer's submissions out of another's list", async () => {
      const a = await seedTrainer('camp6a');
      const b = await seedTrainer('camp6b');
      await submit(a, 'jamie6@example.com');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/trainers/me/camp-submissions')
        .set(auth(b.token))
        .expect(200);
      expect(listed.body).toEqual([]);
    });

    it('scrubs a submission when the person who filled it in is erased', async () => {
      const trainer = await seedTrainer('camp7');
      const submission = await submit(trainer, 'jamie7@example.com');
      await request(app.getHttpServer())
        .post(`/api/v1/camp-submissions/${submission.token}/register`)
        .send({ password: 'Str0ng!Passw0rd' })
        .expect(201);

      const admin = await ctx.seedSuperAdmin();
      const adminToken = await login(admin.email, admin.password);
      const account = await ctx.dataSource
        .getRepository(User)
        .findOneBy({ email: 'jamie7@example.com' });

      await request(app.getHttpServer())
        .delete(`/api/v1/users/${account!.id}`)
        .set(auth(adminToken))
        .send({ reason: 'gdpr request' })
        .expect(200);

      // The form held a name, a phone number and a date of birth of its own.
      const row = await ctx.dataSource
        .getRepository(CampSubmission)
        .findOneBy({ trainerProfileId: trainer.profileId });
      expect(row).toMatchObject({
        firstName: 'Deleted',
        lastName: null,
        phone: null,
        birthDate: null,
      });
      expect(row!.email).not.toBe('jamie7@example.com');
    });
  });
});
