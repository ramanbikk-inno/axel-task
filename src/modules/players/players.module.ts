import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { PlayerProfile } from './entities/player-profile.entity';
import { PlayersService } from './players.service';

@Module({
  imports: [TypeOrmModule.forFeature([PlayerProfile]), AuditModule],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
