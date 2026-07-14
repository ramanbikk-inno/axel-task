import { Module } from '@nestjs/common';

import { AbilityModule } from '../ability/ability.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [UsersModule, TrainersModule, AuthModule, MailModule, AbilityModule, AuditModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
