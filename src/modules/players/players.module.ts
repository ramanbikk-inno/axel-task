import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlayerProfile } from './entities/player-profile.entity';
import { PlayersService } from './players.service';

@Module({
  imports: [TypeOrmModule.forFeature([PlayerProfile])],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
