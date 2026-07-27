import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { UserDeletionLog } from '../src/modules/admin/entities/user-deletion-log.entity';
import { PlayerProfile } from '../src/modules/players/entities/player-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { UserStatus } from '../src/modules/users/entities/user.enums';

/**
 * The erasure itself already worked; what was missing was the legal record it
 * has to leave behind, and three pieces of PII the sweep walked past
 * — the stored photo, the emergency contact, and the children's own logins.
 */
describe('GDPR deletion completeness (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const REASON = 'Account holder exercised right to erasure.';
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
    ctx.storage.upload.mockReset();
    ctx.storage.delete.mockReset();
    ctx.storage.delete.mockResolvedValue(undefined);
  });

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body.accessToken as string;
  };

  const adminSession = async (): Promise<{ token: string; id: string }> => {
    const sa = await ctx.seedSuperAdmin();
    const token = await login(sa.email, sa.password);
    const admin = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { email: sa.email } })) as User;
    return { token, id: admin.id };
  };

  /**
   * A parent with a photo, a child with an emergency contact and their own
   * photo, and a child login.
   */
  const seedFamily = async (): Promise<{
    parent: { email: string; password: string; userId: string };
    parentToken: string;
    childProfileId: string;
    childUserId: string;
    childEmail: string;
  }> => {
    const parent = await ctx.registerVerifiedPlayer({ email: 'erase-me@example.com' });
    const parentToken = await login(parent.email, parent.password);

    ctx.storage.upload.mockResolvedValue({ url: 'https://cdn/face.png', publicId: 'avatars/face' });
    await request(app.getHttpServer())
      .post('/api/v1/profile/me/photo')
      .set(auth(parentToken))
      .send({ fileName: 'face.png', mimeType: 'image/png', dataBase64: PNG })
      .expect(200);

    const child = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(parentToken))
      .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    const childProfileId = child.body.id as string;

    ctx.storage.upload.mockResolvedValueOnce({
      url: 'https://cdn/child-face.png',
      publicId: 'avatars/child-face',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/players/children/${childProfileId}/photo`)
      .set(auth(parentToken))
      .send({ fileName: 'child-face.png', mimeType: 'image/png', dataBase64: PNG })
      .expect(200);

    // Emergency contact is third-party PII, written directly since there is no
    // endpoint for it yet.
    await ctx.dataSource
      .getRepository(PlayerProfile)
      .update(
        { id: childProfileId },
        { emergencyContact: { name: 'Gran', phone: '+1 555 000 1111' }, skillLevel: 'Advanced' },
      );

    const childEmail = 'alex.erase@example.com';
    const created = await request(app.getHttpServer())
      .post(`/api/v1/players/children/${childProfileId}/login`)
      .set(auth(parentToken))
      .send({ email: childEmail, password: CHILD_PASSWORD })
      .expect(201);

    return {
      parent,
      parentToken,
      childProfileId,
      childUserId: created.body.childUserId as string,
      childEmail,
    };
  };

  const deleteUser = (adminToken: string, userId: string): request.Test =>
    request(app.getHttpServer())
      .delete(`/api/v1/users/${userId}`)
      .set(auth(adminToken))
      .send({ reason: REASON });

  it('writes the compliance record the spec requires', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    const log = (await ctx.dataSource
      .getRepository(UserDeletionLog)
      .findOne({ where: { userId: fam.parent.userId } })) as UserDeletionLog;

    // "Original user ID, who deleted, when, reason (for legal compliance)".
    expect(log).not.toBeNull();
    expect(log.originalEmail).toBe('erase-me@example.com');
    expect(log.deletedByUserId).toBe(admin.id);
    expect(log.reason).toBe(REASON);
    expect(log.deletedAt).toBeInstanceOf(Date);
  });

  it('anonymises the account itself', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    const user = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: fam.parent.userId }, withDeleted: true })) as User;

    expect(user.email).toBe(`deleted_${fam.parent.userId}@example.com`);
    expect(user.firstName).toBe('Deleted');
    expect(user.lastName).toBe('User');
    expect(user.phone).toBeNull();
    expect(user.status).toBe(UserStatus.Deleted);
  });

  it('deletes the stored photo, not just the link to it', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    // Nulling photoUrl alone left the image being served from the CDN — the
    // person's face, still public, after an erasure request.
    expect(ctx.storage.delete).toHaveBeenCalledWith('avatars/face');

    const user = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: fam.parent.userId }, withDeleted: true })) as User;
    expect(user.photoUrl).toBeNull();
    expect(user.photoPublicId).toBeNull();
  });

  it("deletes the child's own stored photo alongside the parent's", async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    // A second photo living on the child's profile row, not the parent's
    // users row — the sweep has to find it by owner, not just by target id.
    expect(ctx.storage.delete).toHaveBeenCalledWith('avatars/child-face');

    const profile = (await ctx.dataSource
      .getRepository(PlayerProfile)
      .findOne({ where: { id: fam.childProfileId }, withDeleted: true })) as PlayerProfile;
    expect(profile.photoUrl).toBeNull();
    expect(profile.photoPublicId).toBeNull();
  });

  it('still completes when the storage provider is down', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();
    ctx.storage.delete.mockRejectedValueOnce(new Error('provider down'));

    // The erasure is already committed by then; an outage must not roll it back.
    await deleteUser(admin.token, fam.parent.userId).expect(200);

    const user = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: fam.parent.userId }, withDeleted: true })) as User;
    expect(user.status).toBe(UserStatus.Deleted);
  });

  it("clears the child's profile PII, including the emergency contact", async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    const profile = (await ctx.dataSource
      .getRepository(PlayerProfile)
      .findOne({ where: { id: fam.childProfileId }, withDeleted: true })) as PlayerProfile;

    expect(profile.displayName).toBe('Deleted User');
    expect(profile.birthDate).toBeNull();
    // Somebody else's name and phone number, which has no business surviving
    // this account.
    expect(profile.emergencyContact).toBeNull();
    expect(profile.skillLevel).toBeNull();
  });

  it("anonymises the children's own logins and cuts their sessions", async () => {
    const admin = await adminSession();
    const fam = await seedFamily();
    const childToken = await login(fam.childEmail, CHILD_PASSWORD);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(childToken)).expect(200);

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    // An erasure that leaves the child's account signed-in-able, with their
    // name and email still on it, has not erased the family's data.
    const childUser = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: fam.childUserId }, withDeleted: true })) as User;
    expect(childUser.email).toBe(`deleted_${fam.childUserId}@example.com`);
    expect(childUser.status).toBe(UserStatus.Deleted);

    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(childToken)).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: fam.childEmail, password: CHILD_PASSWORD })
      .expect(401);
  });

  it('cuts the deleted user out of their own live session', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await deleteUser(admin.token, fam.parent.userId).expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(auth(fam.parentToken))
      .expect(401);
  });

  it('cannot be reactivated', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();
    await deleteUser(admin.token, fam.parent.userId).expect(200);

    // "User cannot be reactivated (anonymization permanent)".
    await request(app.getHttpServer())
      .post(`/api/v1/users/${fam.parent.userId}/reactivate`)
      .set(auth(admin.token))
      .send({})
      .expect(409);
  });

  it('cannot be deleted twice, and the record is not overwritten', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();
    await deleteUser(admin.token, fam.parent.userId).expect(200);

    await deleteUser(admin.token, fam.parent.userId).expect(409);

    const logs = await ctx.dataSource
      .getRepository(UserDeletionLog)
      .find({ where: { userId: fam.parent.userId } });
    expect(logs).toHaveLength(1);
  });

  it('still requires a reason', async () => {
    const admin = await adminSession();
    const fam = await seedFamily();

    await request(app.getHttpServer())
      .delete(`/api/v1/users/${fam.parent.userId}`)
      .set(auth(admin.token))
      .send({})
      .expect(422);

    // Nothing was written, so the account is untouched.
    const user = (await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: fam.parent.userId } })) as User;
    expect(user.status).toBe(UserStatus.Active);
  });
});
