import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import { DB_POOL_SIZE_DEFAULT } from '../config/env.validation';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        synchronize: false,
        autoLoadEntities: true,
        entities: [__dirname + '/../../**/*.entity.{ts,js}'],
        migrations: [__dirname + '/migrations/*.{ts,js}'],
        migrationsRun: false,
        // Left unset, node-postgres caps the pool at 10 and the API queues
        // behind it well before the database is the bottleneck.
        extra: { max: config.get<number>('DB_POOL_SIZE') ?? DB_POOL_SIZE_DEFAULT },
      }),
    }),
  ],
})
export class DatabaseModule {}
