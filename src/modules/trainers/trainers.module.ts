import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { OrgMembershipModule } from '../org-membership/org-membership.module';
import { StorageModule } from '../storage/storage.module';
import { TrainerProfile } from './entities/trainer-profile.entity';
import { TrainersController } from './trainers.controller';
import { TrainersService } from './trainers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TrainerProfile]),
    OrgMembershipModule,
    StorageModule,
    AuditModule,
  ],
  controllers: [TrainersController],
  providers: [TrainersService],
  exports: [TrainersService],
})
export class TrainersModule {}
