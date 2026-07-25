import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser, FACTORY_PASSWORD } from './helpers/user.factory';
import { TrainerProfile } from '../src/modules/trainers/entities/trainer-profile.entity';
import { Role } from '../src/modules/users/entities/user.enums';
import { ErrorCode } from '../src/shared/errors/error-codes';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const SCRIPT = Buffer.from('<script>alert(document.cookie)</script>');
const b64 = (b: Buffer): string => b.toString('base64');

/**
 * The declared mimeType is attacker-controlled and was never checked against
 * the bytes, so any payload could be stored as image/png.
 */
describe('Upload content validation (e2e)', () => {
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

  const trainerToken = async (email: string): Promise<string> => {
    const user = await createUser(ctx.dataSource, { role: Role.Trainer, email });
    const repo = ctx.dataSource.getRepository(TrainerProfile);
    await repo.save(repo.create({ userId: user.id, businessName: 'Elite Hoops' }));
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: FACTORY_PASSWORD })
      .expect(200);
    return login.body.accessToken as string;
  };

  const playerToken = async (): Promise<string> => {
    const player = await ctx.registerVerifiedPlayer();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: player.email, password: player.password })
      .expect(200);
    return login.body.accessToken as string;
  };

  it('rejects a script uploaded as a trainer logo declared image/png', async () => {
    const token = await trainerToken('logo-attacker@example.com');

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: b64(SCRIPT) })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE));

    // Nothing was handed to storage.
    expect(ctx.storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a script uploaded as a profile photo declared image/png', async () => {
    const token = await playerToken();

    await request(app.getHttpServer())
      .post('/api/v1/profile/me/photo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'me.png', mimeType: 'image/png', dataBase64: b64(SCRIPT) })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE));

    expect(ctx.storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a real JPEG that claims to be a PNG', async () => {
    const token = await trainerToken('mismatch@example.com');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: b64(jpeg) })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE));
  });

  it('still accepts a genuine PNG logo and stores the returned URL', async () => {
    const token = await trainerToken('good-logo@example.com');

    const res = await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: b64(PNG) })
      .expect(200);

    expect(ctx.storage.upload).toHaveBeenCalledTimes(1);
    expect(res.body.logoUrl).toBe('https://storage.test/uploads/mock.png');
  });

  it('still accepts a genuine SVG logo, which storage rasterises', async () => {
    const token = await trainerToken('svg-logo@example.com');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'logo.svg', mimeType: 'image/svg+xml', dataBase64: b64(svg) })
      .expect(200);

    expect(ctx.storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/svg+xml' }),
    );
  });

  it('rejects an oversized logo before touching storage', async () => {
    const token = await trainerToken('big-logo@example.com');
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);

    await request(app.getHttpServer())
      .post('/api/v1/trainers/me/logo')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'logo.png', mimeType: 'image/png', dataBase64: b64(big) })
      .expect(400)
      .expect((r) => expect(r.body.errorCode).toBe(ErrorCode.FILE_TOO_LARGE));

    expect(ctx.storage.upload).not.toHaveBeenCalled();
  });
});
