import { HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { validate } from './shared/config/env.validation';
import { DatabaseModule } from './shared/database/database.module';
import { ClockModule } from './shared/clock/clock.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { HealthModule } from './shared/health/health.module';
import { AllExceptionsFilter } from './shared/errors/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ validate, isGlobal: true }),
    DatabaseModule,
    ClockModule,
    CryptoModule,
    HealthModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    },
  ],
})
export class AppModule {}
