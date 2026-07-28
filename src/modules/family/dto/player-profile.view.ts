import { ApiProperty } from '@nestjs/swagger';

import { EmergencyContact, PlayerProfile } from '../../players/entities/player-profile.entity';

export class TrainerContextView {
  @ApiProperty()
  trainerProfileId!: string;

  @ApiProperty()
  businessName!: string;

  /**
   * When the association began. The column existed from the start but was never
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

  /** Set by the trainer, read-only here. */
  @ApiProperty({ nullable: true })
  skillLevel!: string | null;

  @ApiProperty({ nullable: true })
  emergencyContact!: EmergencyContact | null;

  /** Only ever set for a child profile; the account holder's own is users.photoUrl. */
  @ApiProperty({ nullable: true })
  photoUrl!: string | null;

  /** Only meaningful for a child profile. Default OFF — see US-01.05. */
  @ApiProperty()
  allowChildTokenSpendNoApproval!: boolean;

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
      photoUrl: profile.photoUrl,
      allowChildTokenSpendNoApproval: profile.allowChildTokenSpendNoApproval,
      trainers,
    };
  }
}
