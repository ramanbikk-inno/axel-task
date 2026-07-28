import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { CoachProfile, CoachStatus } from '../src/modules/coaches/entities/coach-profile.entity';
import { ShareLink } from '../src/modules/enrollment/entities/share-link.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role } from '../src/modules/users/entities/user.enums';

/**
 * The copies of a person's data that live outside `users`: a child login is not
 * the owner of its own profile, a coach's address is copied into
 * `share_links.target_email`, and the invitation actions copy it again into
 * `audit_logs.metadata`. Each survived a completed erasure.
 */
describe('GDPR residual PII (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const REASON = 'Right to erasure.';
  const CHILD_PASSWORD = 'K1dSafe!Passw0rd';

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

  const adminToken = async (): Promise<string> => {
    const sa = await ctx.seedSuperAdmin();
    return login(sa.email, sa.password);
  };

  const deleteUser = (token: string, userId: string): request.Test =>
    request(app.getHttpServer())
      .delete(`/api/v1/users/${userId}`)
      .set(auth(token))
      .send({ reason: REASON });

  describe('a child login erased directly', () => {
    it("anonymises the child's own profile, which the owner sweep never reaches", async () => {
      const admin = await adminToken();
      const parent = await ctx.registerVerifiedPlayer({ email: 'parent-keep@example.com' });
      const parentToken = await login(parent.email, parent.password);

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female', school: 'Oakwood' })
        .expect(201);
      const childProfileId = child.body.id as string;

      await ctx.dataSource
        .getRepository(PlayerProfile)
        .update(
          { id: childProfileId },
          { emergencyContact: { name: 'Gran', phone: '+1 555 000 1111' } },
        );

      const created = await request(app.getHttpServer())
        .post(`/api/v1/players/children/${childProfileId}/login`)
        .set(auth(parentToken))
        .send({ email: 'alex.erase@example.com', password: CHILD_PASSWORD })
        .expect(201);

      // The child account is the target, not the parent.
      await deleteUser(admin, created.body.childUserId as string).expect(200);

      const profile = (await ctx.dataSource
        .getRepository(PlayerProfile)
        .findOne({ where: { id: childProfileId } })) as PlayerProfile;

      expect(profile.displayName).toBe('Deleted User');
      expect(profile.school).toBeNull();
      expect(profile.birthDate).toBeNull();
      expect(profile.gender).toBeNull();
      expect(profile.emergencyContact).toBeNull();
    });

    it("leaves the parent's own profile untouched", async () => {
      const admin = await adminToken();
      const parent = await ctx.registerVerifiedPlayer({ email: 'parent-keep2@example.com' });
      const parentToken = await login(parent.email, parent.password);

      const child = await request(app.getHttpServer())
        .post('/api/v1/players/children')
        .set(auth(parentToken))
        .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
        .expect(201);
      const created = await request(app.getHttpServer())
        .post(`/api/v1/players/children/${child.body.id}/login`)
        .set(auth(parentToken))
        .send({ email: 'alex2.erase@example.com', password: CHILD_PASSWORD })
        .expect(201);

      await deleteUser(admin, created.body.childUserId as string).expect(200);

      const parentUser = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { id: parent.userId } })) as User;
      expect(parentUser.email).toBe('parent-keep2@example.com');
    });
  });

  describe("a coach's address outside the users table", () => {
    /** A trainer with an accepted coach invitation naming the coach's email. */
    const seedInvitedCoach = async (
      coachEmail: string,
    ): Promise<{ admin: string; coachUserId: string }> => {
      const admin = await adminToken();

      const trainerEmail = `trainer-${coachEmail}`;
      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: trainerEmail,
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      await trainers.save(
        trainers.create({ userId: trainerUser.id, businessName: 'Elite Soccer' }),
      );
      const trainerToken = await login(trainerEmail, FACTORY_PASSWORD);

      const invitation = await request(app.getHttpServer())
        .post('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .send({ email: coachEmail })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${invitation.body.code as string}/accept`)
        .send({ password: 'C0ach!Passw0rd', firstName: 'Cody' })
        .expect(201);

      const coach = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: coachEmail } })) as User;
      return { admin, coachUserId: coach.id };
    };

    it('matches the stored copy case-insensitively', async () => {
      // users.email is citext; share_links.target_email is plain text holding
      // whatever the trainer typed. A byte-comparison would walk straight past
      // an invitation addressed to the same person in different case.
      const coachEmail = 'MixedCase.Coach@Example.com';
      const { admin, coachUserId } = await seedInvitedCoach(coachEmail);

      const links = ctx.dataSource.getRepository(ShareLink);
      const invite = (await links.findOne({
        where: { targetEmail: coachEmail },
      })) as ShareLink;
      // Force a casing difference between the two copies of the address.
      await links.update({ id: invite.id }, { targetEmail: coachEmail.toUpperCase() });

      await deleteUser(admin, coachUserId).expect(200);

      const after = (await links.findOne({ where: { id: invite.id } })) as ShareLink;
      expect(after.targetEmail).toBeNull();
      expect(after.active).toBe(false);
    });

    it('leaves audit rows belonging to other people untouched', async () => {
      const keptEmail = 'bystander-coach@example.com';
      await seedInvitedCoach(keptEmail);
      const erasedEmail = 'erased-coach@example.com';
      const { admin, coachUserId } = await seedInvitedCoach(erasedEmail);

      await deleteUser(admin, coachUserId).expect(200);

      const rows = await ctx.dataSource.getRepository(AuditLog).find();
      const emails = rows.map((r) => r.metadata?.email).filter((e) => e !== undefined);
      // The erasure is targeted: one person's address goes, everyone else's
      // stays, or the trail stops being usable for anybody.
      expect(emails).toContain(keptEmail);
      expect(emails).not.toContain(erasedEmail);
    });

    it('clears share_links.target_email and retires the invitation', async () => {
      const coachEmail = 'coach-pii@example.com';
      const { admin, coachUserId } = await seedInvitedCoach(coachEmail);

      // Precondition: the address really is sitting in the invitations table.
      const before = await ctx.dataSource.getRepository(ShareLink).find();
      expect(before.some((l) => l.targetEmail === coachEmail)).toBe(true);

      await deleteUser(admin, coachUserId).expect(200);

      const after = await ctx.dataSource.getRepository(ShareLink).find();
      expect(after.some((l) => l.targetEmail === coachEmail)).toBe(false);
      // A link whose recipient no longer exists must not stay redeemable.
      expect(after.filter((l) => l.targetEmail === null).every((l) => l.active === false)).toBe(
        true,
      );
    });

    it('redacts the address from retained audit metadata without destroying the trail', async () => {
      const coachEmail = 'coach-audit@example.com';
      const { admin, coachUserId } = await seedInvitedCoach(coachEmail);

      const before = await ctx.dataSource.getRepository(AuditLog).find();
      const invited = before.filter((r) => r.action === 'coach.invited');
      expect(invited.length).toBeGreaterThan(0);
      expect(invited.some((r) => r.metadata?.email === coachEmail)).toBe(true);

      await deleteUser(admin, coachUserId).expect(200);

      const after = await ctx.dataSource.getRepository(AuditLog).find();
      expect(after.some((r) => r.metadata?.email === coachEmail)).toBe(false);

      // The trail itself survives: same rows, same actions, only the address
      // replaced. Destroying them would defeat the record's whole purpose.
      const stillInvited = after.filter((r) => r.action === 'coach.invited');
      expect(stillInvited.length).toBe(invited.length);
      expect(stillInvited.every((r) => r.metadata?.email === '[redacted]')).toBe(true);
    });
  });

  describe("a coach's own profile PII", () => {
    it('clears bio, credentials and certifications, and drops the coach from the public roster', async () => {
      const admin = await adminToken();
      const coachEmail = 'coach-erasure-profile@example.com';
      const trainerEmail = `trainer-${coachEmail}`;

      const trainerUser = await createUser(ctx.dataSource, {
        role: Role.Trainer,
        email: trainerEmail,
      });
      const trainers = ctx.dataSource.getRepository(TrainerProfile);
      const trainer = await trainers.save(
        trainers.create({ userId: trainerUser.id, businessName: 'Pro Tennis' }),
      );
      const trainerToken = await login(trainerEmail, FACTORY_PASSWORD);

      const invitation = await request(app.getHttpServer())
        .post('/api/v1/coaches/invitations')
        .set(auth(trainerToken))
        .send({ email: coachEmail })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/coaches/invitations/${invitation.body.code as string}/accept`)
        .send({ password: 'C0ach!Passw0rd', firstName: 'Cody' })
        .expect(201);

      const verifyUrl = (
        ctx.mailer.sendVerification.mock.calls[
          ctx.mailer.sendVerification.mock.calls.length - 1
        ][0] as { verifyUrl: string }
      ).verifyUrl;
      const verifyToken = new URL(verifyUrl).searchParams.get('token') as string;
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ token: verifyToken })
        .expect(200);

      const coachToken = await login(coachEmail, 'C0ach!Passw0rd');
      await request(app.getHttpServer())
        .patch('/api/v1/coaches/me')
        .set(auth(coachToken))
        .send({
          bio: 'Ten years coaching juniors.',
          credentials: 'USPTA certified',
          certifications: 'Level 3',
          publicVisible: true,
        })
        .expect(200);

      // Precondition: the coach really is on the public roster before erasure.
      const before = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${trainer.id}`)
        .set(auth(trainerToken))
        .expect(200);
      expect(
        before.body.some((c: { bio: string | null }) => c.bio === 'Ten years coaching juniors.'),
      ).toBe(true);

      const coachUser = (await ctx.dataSource
        .getRepository(User)
        .findOne({ where: { email: coachEmail } })) as User;
      await deleteUser(admin, coachUser.id).expect(200);

      const profile = (await ctx.dataSource
        .getRepository(CoachProfile)
        .findOne({ where: { userId: coachUser.id } })) as CoachProfile;
      expect(profile.bio).toBeNull();
      expect(profile.credentials).toBeNull();
      expect(profile.certifications).toBeNull();
      expect(profile.publicVisible).toBe(false);
      expect(profile.status).toBe(CoachStatus.Inactive);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/coaches/public/${trainer.id}`)
        .set(auth(trainerToken))
        .expect(200);
      expect(after.body).toHaveLength(0);
    });
  });
});
