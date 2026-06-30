import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TrainerProfile } from './entities/trainer-profile.entity';
import { TrainersService } from './trainers.service';

@Module({
  imports: [TypeOrmModule.forFeature([TrainerProfile])],
  providers: [TrainersService],
  exports: [TrainersService],
})
export class TrainersModule {}
