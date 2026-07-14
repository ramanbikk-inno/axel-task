import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

describe('Trainer portal branding (e2e, US-01.14)', () => {
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
    const profile = await ctx.dataSource
      .getRepository(TrainerProfile)
      .save(ctx.dataSource.getRepository(TrainerProfile).create({ userId: user.id, businessName }));
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return { token: login.body.accessToken as string, trainerProfileId: profile.id };
  };

  it('trainer sets primary color and uploads a logo, then reads own branding', async () => {
    const trainer = await makeTrainer('coach@example.com', 'Elite Hoops');

    await request(app.getHttpServer())
      .patch('/api/v1/trainers/me/branding')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ primaryColor: '#1e88e5' })
      .expect(200)
      .expect((r) => expect(r.body.primaryColor).toBe('#1e88e5'));

    const logo = await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({
        fileName: 'logo.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('fake-logo').toString('base64'),
      })
      .expect(200);
    expect(logo.body.logoUrl).toBe('https://storage.test/uploads/mock.png');

    const mine = await request(app.getHttpServer())
      .get('/api/v1/trainers/me/branding')
      .set('Authorization', `Bearer ${trainer.token}`)
      .expect(200);
    expect(mine.body.businessName).toBe('Elite Hoops');
    expect(mine.body.primaryColor).toBe('#1e88e5');
    expect(mine.body.logoUrl).toBe('https://storage.test/uploads/mock.png');
  });

  it('org users (players) can read a trainer`s branding by id to render the portal', async () => {
    const trainer = await makeTrainer('coach2@example.com', 'Beta Ballers');
    await request(app.getHttpServer())
      .patch('/api/v1/trainers/me/branding')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ primaryColor: '#ff5722' })
      .expect(200);

    const player = await ctx.registerVerifiedPlayer({ email: 'p@example.com' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/trainers/${trainer.trainerProfileId}/branding`)
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(200);
    expect(res.body.businessName).toBe('Beta Ballers');
    expect(res.body.primaryColor).toBe('#ff5722');
  });

  it('rejects an invalid hex color (422) and an oversized logo (400)', async () => {
    const trainer = await makeTrainer('coach3@example.com', 'Gamma Gym');

    await request(app.getHttpServer())
      .patch('/api/v1/trainers/me/branding')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ primaryColor: 'blue' })
      .expect(422);

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({
        fileName: 'big.png',
        mimeType: 'image/png',
        dataBase64: Buffer.alloc(2 * 1024 * 1024 + 16).toString('base64'),
      })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.FILE_TOO_LARGE));

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${trainer.token}`)
      .send({ fileName: 'x.gif', mimeType: 'image/gif', dataBase64: 'AAAA' })
      .expect(422);
  });

  it('forbids non-trainers from editing branding', async () => {
    const player = await ctx.registerVerifiedPlayer({ email: 'np@example.com' });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/api/v1/trainers/me/branding')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ primaryColor: '#000000' })
      .expect(403);
  });
});
