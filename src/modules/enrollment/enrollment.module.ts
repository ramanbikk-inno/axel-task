import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { CryptoModule } from '../../shared/crypto/crypto.module';
import { RegistrationModule } from '../../shared/registration/registration.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { PlayersModule } from '../players/players.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { AssociationsService } from './associations.service';
import {
  CampSubmissionsController,
  TrainerCampSubmissionsController,
} from './camp-submissions.controller';
import { CampSubmissionsService } from './camp-submissions.service';
import { JoinController } from './join.controller';
import { JoinService } from './join.service';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';
import { CampSubmission } from './entities/camp-submission.entity';
import { ShareLink } from './entities/share-link.entity';
import { TrainerPlayerAssociation } from './entities/trainer-player-association.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ShareLink, TrainerPlayerAssociation, CampSubmission]),
    AuthModule,
    UsersModule,
    PlayersModule,
    TrainersModule,
    MailModule,
    AuditModule,
    CryptoModule,
    RegistrationModule,
    ClockModule,
  ],
  controllers: [
    ShareLinksController,
    RosterController,
    JoinController,
    CampSubmissionsController,
    TrainerCampSubmissionsController,
  ],
  providers: [
    JoinService,
    RosterService,
    ShareLinksService,
    AssociationsService,
    CampSubmissionsService,
  ],
  exports: [ShareLinksService, AssociationsService, CampSubmissionsService],
})
export class EnrollmentModule {}
