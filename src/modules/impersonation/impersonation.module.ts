import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AbilityModule } from '../ability/ability.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { UsersModule } from '../users/users.module';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuthSession, RefreshToken, ImpersonationLog]),
    AuthModule,
    UsersModule,
    AbilityModule,
    AuditModule,
  ],
  controllers: [ImpersonationController],
  providers: [ImpersonationService],
  exports: [ImpersonationService],
})
export class ImpersonationModule {}
