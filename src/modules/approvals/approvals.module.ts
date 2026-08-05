import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClockModule } from '../../shared/clock/clock.module';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { MailModule } from '../mail/mail.module';
import { OrgMembershipModule } from '../org-membership/org-membership.module';
import { PlayersModule } from '../players/players.module';
import { UsersModule } from '../users/users.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { PurchaseApproval } from './entities/purchase-approval.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([PurchaseApproval]),
    EventsModule,
    OrgMembershipModule,
    PlayersModule,
    UsersModule,
    MailModule,
    AuditModule,
    ClockModule,
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
