import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TrainerPlayerAssociation } from '../enrollment/entities/trainer-player-association.entity';
import { PlayersModule } from '../players/players.module';
import { OrgMembershipService } from './org-membership.service';

// The association entity is registered directly rather than by importing
// EnrollmentModule or TrainersModule: EnrollmentModule already imports
// TrainersModule, and both consume this module, so either import is a cycle.
@Module({
  imports: [TypeOrmModule.forFeature([TrainerPlayerAssociation]), PlayersModule],
  providers: [OrgMembershipService],
  exports: [OrgMembershipService],
})
export class OrgMembershipModule {}
