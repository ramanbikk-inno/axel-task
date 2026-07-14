import { HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { validate } from './shared/config/env.validation';
import { DatabaseModule } from './shared/database/database.module';
import { ClockModule } from './shared/clock/clock.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { HealthModule } from './shared/health/health.module';
import { AllExceptionsFilter } from './shared/errors/all-exceptions.filter';
import { UsersModule } from './modules/users/users.module';
import { MailModule } from './modules/mail/mail.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { AbilityModule } from './modules/ability/ability.module';
import { AdminModule } from './modules/admin/admin.module';
import { ImpersonationModule } from './modules/impersonation/impersonation.module';
import { PlayersModule } from './modules/players/players.module';
import { EnrollmentModule } from './modules/enrollment/enrollment.module';
import { AuthThrottlerGuard } from './modules/auth/guards/auth-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ validate, isGlobal: true }),
    DatabaseModule,
    ClockModule,
    CryptoModule,
    HealthModule,
    UsersModule,
    MailModule,
    StorageModule,
    AuthModule,
    AbilityModule,
    AdminModule,
    ImpersonationModule,
    PlayersModule,
    EnrollmentModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 60 }]),
  ],
  controllers: [],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      }),
    },
    { provide: APP_GUARD, useClass: AuthThrottlerGuard },
  ],
})
export class AppModule {}
