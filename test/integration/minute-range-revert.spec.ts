import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

// Widening the minute range to 1440 made rows legal that the old constraint
// cannot represent, so its down() has to reconcile them BEFORE restoring the
// narrower check. Clamping alone is not enough: a 23:59-24:00 window clamps to
// an empty range, which the range check rejects while it is still attached, and
// the revert aborts. Asserted against real Postgres because the failure is a
// CHECK constraint firing mid-migration, not application logic.

jest.setTimeout(180000);

describe('minute-range widening is reversible (schema)', () => {
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
    await ds.runMigrations();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await container.stop();
  });

  it('reverts cleanly with rows only the widened bound allows', async () => {
    const [{ id: userId }] = await ds.query(
      `INSERT INTO users (email, role, status, email_verified, must_set_password, token_version)
       VALUES ('revert-owner@example.com', 'PlayerParent', 'Active', true, false, 0)
       RETURNING id`,
    );
    const [{ id: playerProfileId }] = await ds.query(
      `INSERT INTO player_profiles (owner_user_id, display_name, is_child)
       VALUES ($1, 'Revert Owner', false) RETURNING id`,
      [userId],
    );

    // A whole day, and the one-minute window that cannot survive a clamp.
    await ds.query(
      `INSERT INTO availability_slots
         (player_profile_id, coach_profile_id, day_of_week, start_minute, end_minute, is_available)
       VALUES ($1, NULL, 1, 0, 1440, true), ($1, NULL, 2, 1439, 1440, true)`,
      [playerProfileId],
    );

    await expect(ds.undoLastMigration()).resolves.not.toThrow();

    const rows: { day_of_week: number; start_minute: number; end_minute: number }[] =
      await ds.query(
        `SELECT day_of_week, start_minute, end_minute FROM availability_slots ORDER BY day_of_week`,
      );
    // The full day narrows to the old bound; the 23:59 window is unrepresentable
    // and is dropped rather than left violating the constraint being restored.
    expect(rows).toEqual([{ day_of_week: 1, start_minute: 0, end_minute: 1439 }]);

    // Re-apply so the container is left as the suite found it.
    await ds.runMigrations();
  });
});
