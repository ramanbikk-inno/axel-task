import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CoachView } from '../../coaches/dto/coach.dto';
import {
  PlayerProfileFields,
  toPlayerProfileFields,
} from '../../players/dto/player-profile-fields';
import { EmergencyContact, PlayerProfile } from '../../players/entities/player-profile.entity';
import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';
import { UserSummaryDto } from './user-summary.dto';

export class AdminTrainerProfileView {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty({ nullable: true }) website!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;

  static from(profile: TrainerProfile): AdminTrainerProfileView {
    return {
      id: profile.id,
      userId: profile.userId,
      businessName: profile.businessName,
      website: profile.website,
      address: profile.address,
      description: profile.description,
    };
  }
}

/**
 * Flat, unlike family's PlayerProfileView: an admin editing surface has no use
 * for the trainer-association list, so it isn't fetched.
 */
export class AdminPlayerProfileView implements PlayerProfileFields {
  @ApiProperty() id!: string;
  @ApiProperty() ownerUserId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() isChild!: boolean;
  @ApiProperty({ nullable: true }) birthDate!: string | null;
  @ApiProperty({ nullable: true }) gender!: string | null;
  @ApiProperty({ nullable: true }) school!: string | null;
  @ApiProperty({ nullable: true }) jerseyNumber!: string | null;
  @ApiProperty({ nullable: true }) skillLevel!: string | null;
  @ApiProperty({ nullable: true }) emergencyContact!: EmergencyContact | null;
  /** Only ever set for a child profile; an account holder's own is users.photoUrl. */
  @ApiProperty({ nullable: true }) photoUrl!: string | null;
  @ApiProperty() allowChildTokenSpendNoApproval!: boolean;

  static from(profile: PlayerProfile): AdminPlayerProfileView {
    // ownerUserId is this view's own addition, not part of the shared field list.
    return { ...toPlayerProfileFields(profile), ownerUserId: profile.ownerUserId };
  }
}

/** One user as the Users tool shows them, plus their role-specific profile. */
export class AdminUserDetailView {
  @ApiProperty({ type: UserSummaryDto }) user!: UserSummaryDto;

  @ApiPropertyOptional({ type: AdminTrainerProfileView, nullable: true })
  trainer!: AdminTrainerProfileView | null;

  @ApiPropertyOptional({ type: AdminPlayerProfileView, nullable: true })
  player!: AdminPlayerProfileView | null;

  @ApiPropertyOptional({ type: CoachView, nullable: true })
  coach!: CoachView | null;
}
