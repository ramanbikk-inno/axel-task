import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EnrollmentModule } from '../enrollment/enrollment.module';
import { PlayersModule } from '../players/players.module';
import { TrainersModule } from '../trainers/trainers.module';
import {
  PlayerAvailabilityController,
  TrainerAvailabilityController,
} from './availability.controller';
import { AvailabilityService } from './availability.service';
import { AvailabilitySlot } from './entities/availability-slot.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AvailabilitySlot]),
    PlayersModule,
    TrainersModule,
    EnrollmentModule,
  ],
  controllers: [PlayerAvailabilityController, TrainerAvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
