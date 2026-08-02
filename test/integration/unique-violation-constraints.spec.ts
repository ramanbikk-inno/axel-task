import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { dataSourceOptionsForUrl } from '../../src/shared/database/data-source';
import { AllExceptionsFilter } from '../../src/shared/errors/all-exceptions.filter';

/**
 * AllExceptionsFilter.UNIQUE_VIOLATION_BY_CONSTRAINT keys on the real
 * constraint/index names from the migrations. A migration that renames one
 * would otherwise silently degrade its 409 to the generic reply with nothing
 * to catch it — this asserts every key still names a real unique index.
 */
jest.setTimeout(180000);

describe('unique-violation constraint map (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('axel_unique_violations')
      .withUsername('axel')
      .withPassword('axel')
      .start();

    ds = new DataSource(dataSourceOptionsForUrl(container.getConnectionUri()));
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await container.stop();
  });

  it('names only unique indexes that exist in the schema', async () => {
    const rows: Array<{ indexname: string }> = await ds.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const existingIndexNames = new Set(rows.map((r) => r.indexname));

    const mappedConstraints = Object.keys(AllExceptionsFilter.UNIQUE_VIOLATION_BY_CONSTRAINT);
    expect(mappedConstraints.length).toBeGreaterThan(0);

    const missing = mappedConstraints.filter((name) => !existingIndexNames.has(name));
    expect(missing).toEqual([]);
  });
});
