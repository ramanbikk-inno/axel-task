import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { CryptoModule } from '../../shared/crypto/crypto.module';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { MailModule } from '../mail/mail.module';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AbilityModule } from '../ability/ability.module';
import { TrainerPlayerAssociation } from '../enrollment/entities/trainer-player-association.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
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
      CoachProfile,
      PlayerProfile,
      TrainerPlayerAssociation,
    ]),
    AbilityModule,
  ],
  controllers: [AuthController, ContextController],
  providers: [TokenService, JwtStrategy, AuthService, SessionValidatorService, ContextService],
  exports: [TokenService, AuthService, SessionValidatorService, ContextService],
})
export class AuthModule {}
