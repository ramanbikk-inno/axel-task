import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { oversizedPngBase64, PNG_1X1_BASE64 } from './helpers/image.fixtures';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Profile editing (e2e, US-01.11)', () => {
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

  const trainerToken = async (email: string): Promise<{ token: string; userId: string }> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(
        ctx.dataSource
          .getRepository(TrainerProfile)
          .create({ userId: user.id, businessName: 'Old Biz' }),
      );
    return { token: await login(email, FACTORY_PASSWORD), userId: user.id };
  };

  it('any user edits their common profile fields; email/role stay read-only', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'p@example.com' });
    const token = await login(player.email, player.password);

    const res = await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Newfirst', lastName: 'Newlast', phone: '+1 555 123 4567' })
      .expect(200);
    expect(res.body.firstName).toBe('Newfirst');
    expect(res.body.phone).toBe('+1 555 123 4567');
    expect(res.body.email).toBe(player.email);
    expect(res.body.role).toBe(Role.PlayerParent);

    const me = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.lastName).toBe('Newlast');
  });

  it('uploads a profile photo (base64) and stores the returned URL', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'photo@example.com' });
    const token = await login(player.email, player.password);

    const res = await request(app.getHttpServer())
      .post('/api/v1/profile/me/photo')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'me.png',
        mimeType: 'image/png',
        dataBase64: PNG_1X1_BASE64,
      })
      .expect(200);
    expect(res.body.photoUrl).toBe('https://storage.test/uploads/mock.png');
  });

  it('rejects an oversized photo (>2MB) and an unsupported type', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'big@example.com' });
    const token = await login(player.email, player.password);

    await request(app.getHttpServer())
      .post('/api/v1/profile/me/photo')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'big.png',
        mimeType: 'image/png',
        dataBase64: oversizedPngBase64(2 * 1024 * 1024),
      })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.FILE_TOO_LARGE));

    await request(app.getHttpServer())
      .post('/api/v1/profile/me/photo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'x.gif', mimeType: 'image/gif', dataBase64: 'AAAA' })
      .expect(422);
  });

  it('trainer edits role-specific org fields; a player cannot use the trainer route', async () => {
    const trainer = await trainerToken('t@example.com');
    const res = await request(app.getHttpServer())
      .patch('/api/v1/profile/me/trainer')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ businessName: 'Elite Hoops', website: 'https://elite.test' })
      .expect(200);
    expect(res.body.trainer.businessName).toBe('Elite Hoops');
    expect(res.body.trainer.website).toBe('https://elite.test');

    const player = await ctx.registerVerifiedPlayer({ email: 'notatrainer@example.com' });
    const ptoken = await login(player.email, player.password);
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me/trainer')
      .set('Authorization', `Bearer ${ptoken}`)
      .send({ businessName: 'Nope' })
      .expect(403);
  });

  it('player edits role-specific self-profile fields (creating the self profile if needed)', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'selfedit@example.com' });
    const token = await login(player.email, player.password);

    const res = await request(app.getHttpServer())
      .patch('/api/v1/profile/me/player')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Court Star', school: 'Central High', jerseyNumber: '23' })
      .expect(200);
    expect(res.body.player.displayName).toBe('Court Star');
    expect(res.body.player.school).toBe('Central High');
    expect(res.body.player.jerseyNumber).toBe('23');
  });

  it('Super Admin edits any user account and the change is audit-logged', async () => {
    const token = await adminToken();
    const target = await ctx.registerVerifiedPlayer({ email: 'target@example.com' });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${target.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Admin', lastName: 'Edited', phone: '+1 555 000 1999' })
      .expect(200);
    expect(res.body.firstName).toBe('Admin');
    expect(res.body.lastName).toBe('Edited');

    const updated = await ctx.dataSource
      .getRepository(User)
      .findOne({ where: { id: target.userId } });
    expect(updated?.firstName).toBe('Admin');

    const logs = await ctx.dataSource
      .getRepository(AuditLog)
      .find({ where: { action: 'user.updated' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].targetUserId).toBe(target.userId);
  });

  it('a non-Super-Admin cannot edit other users', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'nonadmin@example.com' });
    const target = await ctx.registerVerifiedPlayer({ email: 'victim@example.com' });
    const token = await login(player.email, player.password);

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${target.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Hacked' })
      .expect(403);
  });
});
