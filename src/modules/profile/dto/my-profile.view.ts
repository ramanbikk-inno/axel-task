import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PlayerProfile } from '../../players/entities/player-profile.entity';
import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';
import { User } from '../../users/entities/user.entity';
import { Role, UserStatus } from '../../users/entities/user.enums';

class TrainerProfileView {
  @ApiProperty() businessName!: string;
  @ApiProperty({ nullable: true }) website!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
}

class SelfPlayerProfileView {
  @ApiProperty() id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true }) school!: string | null;
  @ApiProperty({ nullable: true }) jerseyNumber!: string | null;
  @ApiProperty({ nullable: true }) gender!: string | null;
  @ApiProperty({ nullable: true }) birthDate!: string | null;
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
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      photoUrl: user.photoUrl,
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
      player: player
        ? {
            id: player.id,
            displayName: player.displayName,
            school: player.school,
            jerseyNumber: player.jerseyNumber,
            gender: player.gender,
            birthDate: player.birthDate,
          }
        : null,
    };
  }
}
