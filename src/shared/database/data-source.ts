import { config as loadDotenv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

loadDotenv();

const baseOptions: PostgresConnectionOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'axel',
  password: process.env.DB_PASSWORD ?? 'axel',
  database: process.env.DB_NAME ?? 'axel',
  synchronize: false,
  logging: false,
  entities: [__dirname + '/../../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
};

export const dataSourceOptions: DataSourceOptions = baseOptions;

/**
 * Build DataSourceOptions with overrides (e.g. a Testcontainers host/port in
 * integration/e2e, or a seed connection). Keeps a single source of truth for
 * entities/migrations globs.
 */
export function dataSourceOptionsForUrl(
  overrides: Partial<PostgresConnectionOptions> = {},
): DataSourceOptions {
  return { ...baseOptions, ...overrides };
}

export const AppDataSource = new DataSource(dataSourceOptions);
