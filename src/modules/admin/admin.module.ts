import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { AbilityModule } from '../ability/ability.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { MailModule } from '../mail/mail.module';
import { PlayersModule } from '../players/players.module';
import { StorageModule } from '../storage/storage.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserDeletionLog } from './entities/user-deletion-log.entity';

@Module({
  imports: [
    UsersModule,
    TrainersModule,
    AuthModule,
    MailModule,
    AbilityModule,
    AuditModule,
    PlayersModule,
    // For ShareLinksService: a GDPR erasure has to reach the coach-invitation
    // copy of the person's email, which lives in this module's table.
    EnrollmentModule,
    StorageModule,
    ClockModule,
    TypeOrmModule.forFeature([UserDeletionLog]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
