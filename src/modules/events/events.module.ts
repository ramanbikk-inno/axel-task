import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { AuditModule } from '../audit/audit.module';
import { AvailabilityModule } from '../availability/availability.module';
import { TrainersModule } from '../trainers/trainers.module';
import { AssignmentsService } from './assignments.service';
import { EventCoachAssignment } from './entities/event-coach-assignment.entity';
import { Event } from './entities/event.entity';
import { CoachAssignmentsController, TrainerEventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, EventCoachAssignment]),
    // For the conflict check, the coach lookup and the override record — the
    // assignment path reuses all three rather than restating them.
    AvailabilityModule,
    TrainersModule,
    AuditModule,
    ClockModule,
  ],
  controllers: [TrainerEventsController, CoachAssignmentsController],
  providers: [EventsService, AssignmentsService],
  exports: [EventsService],
})
export class EventsModule {}
