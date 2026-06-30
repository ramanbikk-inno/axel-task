import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { ClockService } from '../src/shared/clock/clock.service';
import { MAILER, Mailer } from '../src/modules/mail/mailer.interface';
import { STORAGE, StorageService } from '../src/modules/storage/storage.service';
import { PasswordService } from '../src/shared/crypto/password.service';
import { Role, UserStatus } from '../src/modules/users/entities/user.enums';
import { User } from '../src/modules/users/entities/user.entity';

export interface E2EContext {
  app: INestApplication;
  dataSource: DataSource;
  mailer: jest.Mocked<Mailer>;
  clock: { set(d: Date): void; advance(ms: number): void };
  resetDb(): Promise<void>;
  seedSuperAdmin(): Promise<{ email: string; password: string }>;
  registerVerifiedPlayer(over?: {
    email?: string;
    password?: string;
  }): Promise<{ email: string; password: string; userId: string }>;
  superAdminEmail: string;
  superAdminPassword: string;
  close(): Promise<void>;
}

class FakeClock {
  private current: Date = new Date('2026-01-01T00:00:00.000Z');

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(d: Date): void {
    this.current = new Date(d.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function buildMockMailer(): jest.Mocked<Mailer> {
  return {
    sendVerification: jest.fn(),
    sendPasswordReset: jest.fn(),
    sendPasswordChanged: jest.fn(),
    sendWelcome: jest.fn(),
    sendTrainerInvite: jest.fn(),
  } as unknown as jest.Mocked<Mailer>;
}

function buildMockStorage(): jest.Mocked<StorageService> {
  return {
    upload: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<StorageService>;
}

export async function bootstrapE2E(): Promise<E2EContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16')
    .withDatabase('axel_test')
    .withUsername('axel')
    .withPassword('axel')
    .start();

  process.env.DB_HOST = container.getHost();
  process.env.DB_PORT = String(container.getPort());
  process.env.DB_USER = container.getUsername();
  process.env.DB_PASSWORD = container.getPassword();
  process.env.DB_NAME = container.getDatabase();

  const { AppDataSource } = await import('../src/shared/database/data-source');
  const migrationDataSource: DataSource = AppDataSource;
  await migrationDataSource.initialize();
  await migrationDataSource.runMigrations();

  const mailer: jest.Mocked<Mailer> = buildMockMailer();
  const storage: jest.Mocked<StorageService> = buildMockStorage();
  const clock = new FakeClock();

  // The app's ConfigService resolves DB params from the .env file, not the
  // process.env overrides set above, so AppModule would otherwise connect to a
  // different database than the one migrations ran on. Pin the app to the
  // already-migrated Testcontainers DataSource so repositories and migrations
  // share one connection.
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(getDataSourceToken())
    .useValue(migrationDataSource)
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(STORAGE)
    .useValue(storage)
    .overrideProvider(ClockService)
    .useValue(clock)
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();

  const dataSource: DataSource = app.get(DataSource);
  const config: ConfigService = app.get(ConfigService);
  const passwords: PasswordService = app.get(PasswordService);

  const superAdminEmail: string = config.get<string>('SUPER_ADMIN_EMAIL') ?? 'admin@example.com';
  const superAdminPassword: string =
    config.get<string>('SUPER_ADMIN_PASSWORD') ?? 'Sup3r!Admin!Pass';

  async function resetDb(): Promise<void> {
    const tableNames: { tablename: string }[] = await dataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
    );
    if (tableNames.length === 0) {
      return;
    }
    const quoted: string = tableNames.map((t) => `"${t.tablename}"`).join(', ');
    await dataSource.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    jest.clearAllMocks();
  }

  async function seedSuperAdmin(): Promise<{ email: string; password: string }> {
    const repository = dataSource.getRepository(User);
    const existing: User | null = await repository.findOne({
      where: { email: superAdminEmail },
    });
    if (existing) {
      return { email: superAdminEmail, password: superAdminPassword };
    }
    const passwordHash: string = await passwords.hash(superAdminPassword);
    const admin: User = repository.create({
      email: superAdminEmail,
      role: Role.SuperAdmin,
      status: UserStatus.Active,
      emailVerified: true,
      emailVerifiedAt: clock.now(),
      mustSetPassword: false,
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
    });
    await repository.save(admin);
    return { email: superAdminEmail, password: superAdminPassword };
  }

  async function registerVerifiedPlayer(
    over: { email?: string; password?: string } = {},
  ): Promise<{ email: string; password: string; userId: string }> {
    const email: string =
      over.email ?? `player-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password: string = over.password ?? 'Str0ng!Passw0rd';

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, firstName: 'Reg', lastName: 'Player' })
      .expect(201);

    const lastCall =
      mailer.sendVerification.mock.calls[mailer.sendVerification.mock.calls.length - 1];
    if (!lastCall) {
      throw new Error('registerVerifiedPlayer: sendVerification was not called');
    }
    const verifyUrl: string = lastCall[0].verifyUrl;
    const token: string = new URL(verifyUrl).searchParams.get('token') ?? '';
    if (!token) {
      throw new Error('registerVerifiedPlayer: no token in verifyUrl');
    }

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token })
      .expect(200);

    const repository = dataSource.getRepository(User);
    const user: User | null = await repository.findOne({ where: { email } });
    if (!user) {
      throw new Error('registerVerifiedPlayer: user not found after verify');
    }

    return { email, password, userId: user.id };
  }

  async function close(): Promise<void> {
    await app.close();
    if (migrationDataSource.isInitialized) {
      await migrationDataSource.destroy();
    }
    await container.stop();
  }

  return {
    app,
    dataSource,
    mailer,
    clock,
    resetDb,
    seedSuperAdmin,
    registerVerifiedPlayer,
    superAdminEmail,
    superAdminPassword,
    close,
  };
}
