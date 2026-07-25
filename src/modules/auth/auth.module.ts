import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { CryptoModule } from '../../shared/crypto/crypto.module';
import { MailModule } from '../mail/mail.module';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountSetupToken } from './entities/account-setup-token.entity';
import { AuthSession } from './entities/auth-session.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { SessionValidatorService } from './session-validator.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenService } from './token.service';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    JwtModule.register({}),
    ClockModule,
    CryptoModule,
    UsersModule,
    MailModule,
    TypeOrmModule.forFeature([
      AuthSession,
      RefreshToken,
      EmailVerificationToken,
      PasswordResetToken,
      AccountSetupToken,
      User,
      TrainerProfile,
    ]),
  ],
  controllers: [AuthController],
  providers: [TokenService, JwtStrategy, AuthService, SessionValidatorService],
  exports: [TokenService, AuthService, SessionValidatorService],
})
export class AuthModule {}
