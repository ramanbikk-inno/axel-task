import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { dataSourceOptionsForUrl } from '../../src/shared/database/data-source';
import { Role, UserStatus } from '../../src/modules/users/entities/user.enums';
import { User } from '../../src/modules/users/entities/user.entity';
import { AuthSession } from '../../src/modules/auth/entities/auth-session.entity';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { EmailVerificationToken } from '../../src/modules/auth/entities/email-verification-token.entity';

describe('Auth entities (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let userId: string;
  let sessionId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('axel_test')
      .withUsername('axel')
      .withPassword('axel')
      .start();

    dataSource = new DataSource(dataSourceOptionsForUrl(container.getConnectionUri()));
    await dataSource.initialize();
    await dataSource.runMigrations();

    const user: User = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `owner-${Date.now()}@example.com`,
        role: Role.PlayerParent,
        status: UserStatus.Active,
        emailVerified: true,
        mustSetPassword: false,
      }),
    );
    userId = user.id;

    const session: AuthSession = await dataSource.getRepository(AuthSession).save(
      dataSource.getRepository(AuthSession).create({
        userId,
        activeTrainerProfileId: null,
        userAgent: 'jest',
        ip: '127.0.0.1',
      }),
    );
    sessionId = session.id;
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (container) {
      await container.stop();
    }
  });

  it('persists a refresh token', async () => {
    const repo = dataSource.getRepository(RefreshToken);
    const saved: RefreshToken = await repo.save(
      repo.create({
        id: 'b3f4c1a2-0000-4000-8000-000000000001',
        sessionId,
        userId,
        familyId: 'fam-1',
        tokenHash: 'hash-refresh-1',
        expiresAt: new Date(Date.now() + 1000),
      }),
    );
    expect(saved.id).toBe('b3f4c1a2-0000-4000-8000-000000000001');
    expect(saved.revokedAt).toBeNull();
    expect(saved.replacedById).toBeNull();
  });

  it('enforces unique tokenHash on refresh tokens', async () => {
    const repo = dataSource.getRepository(RefreshToken);
    await expect(
      repo.save(
        repo.create({
          id: 'b3f4c1a2-0000-4000-8000-000000000002',
          sessionId,
          userId,
          familyId: 'fam-1',
          tokenHash: 'hash-refresh-1',
          expiresAt: new Date(Date.now() + 1000),
        }),
      ),
    ).rejects.toThrow();
  });

  it('persists an email verification token and enforces unique tokenHash', async () => {
    const repo = dataSource.getRepository(EmailVerificationToken);
    const saved: EmailVerificationToken = await repo.save(
      repo.create({
        userId,
        tokenHash: 'hash-verify-1',
        expiresAt: new Date(Date.now() + 1000),
      }),
    );
    expect(saved.consumedAt).toBeNull();

    await expect(
      repo.save(
        repo.create({
          userId,
          tokenHash: 'hash-verify-1',
          expiresAt: new Date(Date.now() + 1000),
        }),
      ),
    ).rejects.toThrow();
  });
});
