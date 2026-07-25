import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { MailModule } from '../mail/mail.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { CoachesController } from './coaches.controller';
import { CoachesService } from './coaches.service';
import { CoachProfile } from './entities/coach-profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CoachProfile]),
    TrainersModule,
    EnrollmentModule,
    AuthModule,
    AuditModule,
    UsersModule,
    MailModule,
  ],
  controllers: [CoachesController],
  providers: [CoachesService],
  exports: [CoachesService],
})
export class CoachesModule {}
