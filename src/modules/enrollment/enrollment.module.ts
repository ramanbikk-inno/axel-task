import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CryptoModule } from '../../shared/crypto/crypto.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { PlayersModule } from '../players/players.module';
import { TrainersModule } from '../trainers/trainers.module';
import { UsersModule } from '../users/users.module';
import { AssociationsService } from './associations.service';
import { EnrollmentService } from './enrollment.service';
import { JoinController } from './join.controller';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';
import { ShareLink } from './entities/share-link.entity';
import { TrainerPlayerAssociation } from './entities/trainer-player-association.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ShareLink, TrainerPlayerAssociation]),
    AuthModule,
    UsersModule,
    PlayersModule,
    TrainersModule,
    MailModule,
    AuditModule,
    CryptoModule,
  ],
  controllers: [ShareLinksController, JoinController],
  providers: [EnrollmentService, ShareLinksService, AssociationsService],
  exports: [EnrollmentService, ShareLinksService, AssociationsService],
})
export class EnrollmentModule {}
