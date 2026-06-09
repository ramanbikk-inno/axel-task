import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './shared/config/env.validation';
import { DatabaseModule } from './shared/database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      validate,
      isGlobal: true,
    }),
    DatabaseModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
