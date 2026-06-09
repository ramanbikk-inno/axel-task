import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { dataSourceOptionsForUrl } from '../../src/shared/database/data-source';
import { User } from '../../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../../src/modules/users/entities/user.enums';
import { PasswordService } from '../../src/shared/crypto/password.service';
import { upsertSuperAdmin } from '../../src/database/seeds/seed-super-admin';

describe('seed-super-admin (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let passwordService: PasswordService;

  const SUPER_ADMIN_EMAIL = 'root@axel.test';
  const SUPER_ADMIN_PASSWORD = 'Str0ng!Passw0rd';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    dataSource = new DataSource(dataSourceOptionsForUrl(container.getConnectionUri()));
    await dataSource.initialize();
    await dataSource.runMigrations();

    // Minimal real PasswordService backed by argon2 (defaults from T3/T9).
    passwordService = new PasswordService({
      get: (key: string): unknown => {
        const map: Record<string, number> = {
          ARGON_MEMORY_KIB: 19456,
          ARGON_TIME_COST: 2,
          ARGON_PARALLELISM: 1,
        };
        return map[key];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
  });

  it('creates exactly one SuperAdmin on first run', async () => {
    await upsertSuperAdmin(dataSource, passwordService, {
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
    });

    const admins: User[] = await dataSource.getRepository(User).find({
      where: { role: Role.SuperAdmin },
    });

    expect(admins).toHaveLength(1);
    expect(admins[0].email).toBe(SUPER_ADMIN_EMAIL);
    expect(admins[0].status).toBe(UserStatus.Active);
    expect(admins[0].emailVerified).toBe(true);
  });

  it('is idempotent: running twice yields exactly one SuperAdmin row', async () => {
    await upsertSuperAdmin(dataSource, passwordService, {
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
    });
    await upsertSuperAdmin(dataSource, passwordService, {
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
    });

    const count: number = await dataSource.getRepository(User).count({
      where: { role: Role.SuperAdmin },
    });

    expect(count).toBe(1);
  });
});
