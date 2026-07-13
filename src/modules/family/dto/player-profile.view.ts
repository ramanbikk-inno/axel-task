import { ApiProperty } from '@nestjs/swagger';

import { PlayerProfile } from '../../players/entities/player-profile.entity';

export class TrainerContextView {
  @ApiProperty()
  trainerProfileId!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty()
  status!: string;
}

export class PlayerProfileView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  isChild!: boolean;

  @ApiProperty({ nullable: true })
  birthDate!: string | null;

  @ApiProperty({ nullable: true })
  gender!: string | null;

  @ApiProperty({ nullable: true })
  school!: string | null;

  @ApiProperty({ nullable: true })
  jerseyNumber!: string | null;

  @ApiProperty({ type: [TrainerContextView] })
  trainers!: TrainerContextView[];

  static from(profile: PlayerProfile, trainers: TrainerContextView[]): PlayerProfileView {
    return {
      id: profile.id,
      displayName: profile.displayName,
      isChild: profile.isChild,
      birthDate: profile.birthDate,
      gender: profile.gender,
      school: profile.school,
      jerseyNumber: profile.jerseyNumber,
      trainers,
    };
  }
}
