import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { MailModule } from '../mail/mail.module';
import { PlayersModule } from '../players/players.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import {
  CoachAvailabilityController,
  CoachOverridesController,
  PlayerAvailabilityController,
  TrainerAvailabilityController,
} from './availability.controller';
import { AvailabilityService } from './availability.service';
import { CoachLookupService } from './coach-lookup.service';
import { CoachOverridesService } from './coach-overrides.service';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import { CoachAvailabilityOverride } from './entities/coach-availability-override.entity';

@Module({
  imports: [
    // CoachProfile directly rather than via CoachesModule, which would drag in
    // Auth and Enrollment for the sake of one row.
    TypeOrmModule.forFeature([AvailabilitySlot, CoachAvailabilityOverride, CoachProfile]),
    PlayersModule,
    TrainersModule,
    UsersModule,
    EnrollmentModule,
    MailModule,
    AuditModule,
  ],
  controllers: [
    PlayerAvailabilityController,
    CoachAvailabilityController,
    TrainerAvailabilityController,
    CoachOverridesController,
  ],
  providers: [AvailabilityService, CoachOverridesService, CoachLookupService],
  exports: [AvailabilityService, CoachOverridesService, CoachLookupService],
})
export class AvailabilityModule {}
