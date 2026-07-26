import { ApiProperty } from '@nestjs/swagger';

import { EmergencyContact, PlayerProfile } from '../../players/entities/player-profile.entity';

export class TrainerContextView {
  @ApiProperty()
  trainerProfileId!: string;

  @ApiProperty()
  businessName!: string;

  /**
   * US-01.04: "For each child, see: Name, Age, Associated Trainers (with
   * dates)". The column was on the association from the start but never
   * surfaced, so the family screen had no date to show.
   */
  @ApiProperty()
  connectedAt!: Date;

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

  /** Set by the trainer, read-only here (section 8). */
  @ApiProperty({ nullable: true })
  skillLevel!: string | null;

  @ApiProperty({ nullable: true })
  emergencyContact!: EmergencyContact | null;

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
      skillLevel: profile.skillLevel,
      emergencyContact: profile.emergencyContact,
      trainers,
    };
  }
}
