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
 * Build DataSourceOptions from a connection URL (e.g. a Testcontainers
 * `getConnectionUri()` in integration/e2e), reusing the same entities/migrations
 * globs so tests run the real migrations without env vars.
 */
export function dataSourceOptionsForUrl(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    ssl: false,
    synchronize: false,
    logging: false,
    entities: baseOptions.entities,
    migrations: baseOptions.migrations,
  };
}

export const AppDataSource = new DataSource(dataSourceOptions);
