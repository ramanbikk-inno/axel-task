import { Module } from '@nestjs/common';

import { RegistrationModule } from '../../shared/registration/registration.module';
import { AuditModule } from '../audit/audit.module';
import { PlayersModule } from '../players/players.module';
import { StorageModule } from '../storage/storage.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  imports: [
    UsersModule,
    TrainersModule,
    PlayersModule,
    StorageModule,
    AuditModule,
    RegistrationModule,
  ],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
