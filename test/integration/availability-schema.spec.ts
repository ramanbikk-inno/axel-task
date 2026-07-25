import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

// The XOR is what keeps one shared table from drifting into rows owned by
// nobody or by a player and a coach at once. Asserted against real Postgres
// because it is a CHECK constraint, not application logic.

jest.setTimeout(180000);

describe('availability_slots owner XOR (schema)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('axel_mig')
      .withUsername('axel')
      .withPassword('axel')
      .start();
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_USER = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    const { AppDataSource } = await import('../../src/shared/database/data-source');
    ds = AppDataSource;
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await container.stop();
  });

  it('rejects a slot owned by both a player and a coach', async () => {
    await expect(
      ds.query(
        `INSERT INTO availability_slots (player_profile_id, coach_profile_id, day_of_week, start_minute, end_minute)
         VALUES (gen_random_uuid(), gen_random_uuid(), 1, 960, 1200)`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a slot owned by nobody', async () => {
    await expect(
      ds.query(
        `INSERT INTO availability_slots (day_of_week, start_minute, end_minute) VALUES (1, 960, 1200)`,
      ),
    ).rejects.toThrow();
  });
});
