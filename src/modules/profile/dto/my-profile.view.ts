import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { EmergencyContact, PlayerProfile } from '../../players/entities/player-profile.entity';
import {
  PlayerProfileFields,
  toPlayerProfileFields,
} from '../../players/dto/player-profile-fields';
import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Role, UserStatus } from '../../users/entities/user.enums';

class TrainerProfileView {
  @ApiProperty() businessName!: string;
  @ApiProperty({ nullable: true }) website!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
}

class SelfPlayerProfileView implements PlayerProfileFields {
  @ApiProperty() id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true }) school!: string | null;
  @ApiProperty({ nullable: true }) jerseyNumber!: string | null;
  @ApiProperty({ nullable: true }) gender!: string | null;
  @ApiProperty({ nullable: true }) birthDate!: string | null;

  /** True when this login is a child's, i.e. the profile is owned by a parent. */
  @ApiProperty() isChild!: boolean;

  /** Set by the trainer; read-only here. */
  @ApiProperty({ nullable: true }) skillLevel!: string | null;

  @ApiProperty({ nullable: true }) emergencyContact!: EmergencyContact | null;

  /** Only ever set on a child profile — see the entity's photoUrl. */
  @ApiProperty({ nullable: true }) photoUrl!: string | null;

  /** Only meaningful for a child profile. Default OFF — see US-01.05. */
  @ApiProperty() allowChildTokenSpendNoApproval!: boolean;
}

/** Aggregated self-profile: editable common fields + role-specific profile. */
export class MyProfileView {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty({ nullable: true }) firstName!: string | null;
  @ApiProperty({ nullable: true }) lastName!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;

  /** An account holder's photo lives on `users`; a child's lives on the player profile. */
  @ApiProperty({ nullable: true }) photoUrl!: string | null;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() createdAt!: Date;

  @ApiPropertyOptional({ type: TrainerProfileView, nullable: true })
  trainer!: TrainerProfileView | null;

  @ApiPropertyOptional({ type: SelfPlayerProfileView, nullable: true })
  player!: SelfPlayerProfileView | null;

  static build(
    user: User,
    trainer: TrainerProfile | null,
    player: PlayerProfile | null,
  ): MyProfileView {
    const isChild = player !== null && player.childUserId === user.id;
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      photoUrl: isChild ? player.photoUrl : user.photoUrl,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      trainer: trainer
        ? {
            businessName: trainer.businessName,
            website: trainer.website,
            address: trainer.address,
            description: trainer.description,
          }
        : null,
      player: player ? { ...toPlayerProfileFields(player), isChild } : null,
    };
  }
}
