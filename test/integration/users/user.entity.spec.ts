import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { User } from '../../../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../../../src/modules/users/entities/user.enums';

describe('User entity (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let users: Repository<User>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: ['src/**/*.entity.{ts,js}'],
      migrations: ['src/shared/database/migrations/*.{ts,js}'],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    users = dataSource.getRepository(User);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (container) {
      await container.stop();
    }
  });

  it('persists a user and defaults status=Active, emailVerified=false, tokenVersion=0', async () => {
    const saved: User = await users.save(
      users.create({
        email: 'persist@example.com',
        role: Role.PlayerParent,
        firstName: 'Pat',
        lastName: 'Player',
      }),
    );

    const found: User | null = await users.findOne({ where: { id: saved.id } });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(saved.id);
    expect(found?.email).toBe('persist@example.com');
    expect(found?.role).toBe(Role.PlayerParent);
    expect(found?.status).toBe(UserStatus.Active);
    expect(found?.emailVerified).toBe(false);
    expect(found?.mustSetPassword).toBe(false);
    expect(found?.isChildAccount).toBe(false);
    expect(found?.tokenVersion).toBe(0);
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate email (citext UNIQUE, case-insensitive)', async () => {
    await users.save(users.create({ email: 'dup@example.com', role: Role.PlayerParent }));

    await expect(
      users.save(users.create({ email: 'DUP@example.com', role: Role.PlayerParent })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('does not return passwordHash by default (select:false)', async () => {
    const saved: User = await users.save(
      users.create({
        email: 'secret@example.com',
        role: Role.PlayerParent,
        passwordHash: 'argon2-hash-placeholder',
      }),
    );

    const found: User | null = await users.findOne({ where: { id: saved.id } });
    expect(found).not.toBeNull();
    expect(found?.passwordHash).toBeUndefined();
  });
});
