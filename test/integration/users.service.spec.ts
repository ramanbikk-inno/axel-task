import { DataSource, Repository } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { dataSourceOptionsForUrl } from '../../src/shared/database/data-source';
import { User } from '../../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../../src/modules/users/entities/user.enums';
import { UsersService } from '../../src/modules/users/users.service';

describe('UsersService (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let service: UsersService;
  let repository: Repository<User>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    dataSource = new DataSource(dataSourceOptionsForUrl(container.getConnectionUri()));
    await dataSource.initialize();
    await dataSource.runMigrations();

    repository = dataSource.getRepository(User);
    service = new UsersService(repository);
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

  it('create + findByEmail round-trips a user', async () => {
    const created: User = await service.create({
      email: 'p1@axel.test',
      role: Role.PlayerParent,
      passwordHash: 'hash-1',
    });

    expect(created.id).toBeDefined();
    expect(created.tokenVersion).toBe(0);

    const found: User | null = await service.findByEmail('p1@axel.test');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
  });

  it('findByEmailWithPassword selects the passwordHash column', async () => {
    await service.create({
      email: 'p2@axel.test',
      role: Role.PlayerParent,
      passwordHash: 'hash-2',
    });

    const withoutPassword: User | null = await service.findByEmail('p2@axel.test');
    expect(withoutPassword?.passwordHash).toBeUndefined();

    const withPassword: User | null = await service.findByEmailWithPassword('p2@axel.test');
    expect(withPassword?.passwordHash).toBe('hash-2');
  });

  it('markEmailVerified sets emailVerified, emailVerifiedAt and Active status', async () => {
    const user: User = await service.create({
      email: 'p3@axel.test',
      role: Role.PlayerParent,
      passwordHash: 'hash-3',
    });
    const at = new Date('2026-06-08T00:00:00.000Z');

    await service.markEmailVerified(user.id, at);

    const reloaded: User | null = await service.findById(user.id);
    expect(reloaded?.emailVerified).toBe(true);
    expect(reloaded?.emailVerifiedAt?.toISOString()).toBe(at.toISOString());
    expect(reloaded?.status).toBe(UserStatus.Active);
  });

  it('setPasswordAndBumpVersion increments tokenVersion and clears mustSetPassword', async () => {
    const user: User = await service.create({
      email: 'p4@axel.test',
      role: Role.Trainer,
      passwordHash: 'old-hash',
      mustSetPassword: true,
    });
    expect(user.tokenVersion).toBe(0);

    await service.setPasswordAndBumpVersion(user.id, 'new-hash');

    const reloaded: User | null = await service.findByIdWithPassword(user.id);
    expect(reloaded?.tokenVersion).toBe(1);
    expect(reloaded?.mustSetPassword).toBe(false);
    expect(reloaded?.passwordHash).toBe('new-hash');
  });

  it('touchLastLogin and updatePasswordHash mutate the expected columns', async () => {
    const user: User = await service.create({
      email: 'p5@axel.test',
      role: Role.PlayerParent,
      passwordHash: 'h5',
    });
    const at = new Date('2026-06-08T12:00:00.000Z');

    await service.touchLastLogin(user.id, at);
    await service.updatePasswordHash(user.id, 'rehashed');

    const reloaded: User | null = await service.findByIdWithPassword(user.id);
    expect(reloaded?.lastLoginAt?.toISOString()).toBe(at.toISOString());
    expect(reloaded?.passwordHash).toBe('rehashed');
    expect(reloaded?.tokenVersion).toBe(0); // updatePasswordHash does NOT bump
  });
});
