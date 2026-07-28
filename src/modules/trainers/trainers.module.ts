import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { TrainerPlayerAssociation } from '../enrollment/entities/trainer-player-association.entity';
import { PlayersModule } from '../players/players.module';
import { StorageModule } from '../storage/storage.module';
import { TrainerProfile } from './entities/trainer-profile.entity';
import { TrainersController } from './trainers.controller';
import { TrainersService } from './trainers.service';

// The entity is registered directly (not via EnrollmentModule) to avoid the
// module cycle: EnrollmentModule already imports TrainersModule.
@Module({
  imports: [
    TypeOrmModule.forFeature([TrainerProfile, TrainerPlayerAssociation]),
    PlayersModule,
    StorageModule,
    AuditModule,
  ],
  controllers: [TrainersController],
  providers: [TrainersService],
  exports: [TrainersService],
})
export class TrainersModule {}
