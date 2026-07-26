import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  IsStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../shared/validation/password';
import { IsOptionalNotNull } from '../../../shared/validation/presence';
import { CoachStatus } from '../entities/coach-profile.entity';

export class InviteCoachDto {
  @ApiProperty({ example: 'coach@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ description: 'Optional message included in the invitation email' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export class AcceptCoachInviteDto {
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}

export type CoachInvitationStatus = 'pending' | 'accepted' | 'expired';

export class CoachInvitationView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() email!: string;
  @ApiProperty() status!: CoachInvitationStatus;
  @ApiProperty({ nullable: true }) expiresAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class CoachView {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true }) firstName!: string | null;
  @ApiProperty({ nullable: true }) lastName!: string | null;
  @ApiProperty({ nullable: true }) bio!: string | null;
  // Accepted by PATCH /coaches/me since US-01.08 but never returned, so a coach
  // could not read back what they had just written.
  @ApiProperty({ nullable: true }) credentials!: string | null;
  @ApiProperty({ nullable: true }) certifications!: string | null;
  @ApiProperty() publicVisible!: boolean;
  @ApiProperty({ enum: ['Active', 'Inactive'] }) status!: CoachStatus;
  @ApiProperty() joinedAt!: Date;
  @ApiProperty({ nullable: true }) endedAt!: Date | null;
}

/**
 * What a coach may change about themselves (spec section 6: "may edit their
 * own profile and availability"). Deliberately does not include the trainer
 * they work for or their status — employment is the trainer's to set.
 */
/**
 * A coach as anyone in the trainer's organisation may see them — the read
 * `publicVisible` exists to gate (US-01.08 "Public profile management").
 * Deliberately narrower than CoachView: no email, no employment dates, nothing
 * a player has no business seeing.
 */
export class PublicCoachView {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) firstName!: string | null;
  @ApiProperty({ nullable: true }) lastName!: string | null;
  @ApiProperty({ nullable: true }) bio!: string | null;
  @ApiProperty({ nullable: true }) credentials!: string | null;
  @ApiProperty({ nullable: true }) certifications!: string | null;
}

export class UpdateCoachProfileDto {
  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  credentials?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  certifications?: string | null;

  /**
   * Now that this gates `GET /coaches/public/:trainerProfileId`, a value the
   * caller did not mean must not be inferred. The transform stays lenient about
   * the string `'true'` that form encodings send, but it no longer folds
   * null/undefined into `false` — doing so quietly un-listed a coach on a
   * request that never mentioned a boolean at all.
   */
  @ApiPropertyOptional({ description: 'Show this profile on the trainer’s public page' })
  @IsOptionalNotNull()
  @Transform(({ value }) =>
    value === null || value === undefined ? value : value === true || value === 'true',
  )
  @IsBoolean()
  publicVisible?: boolean;
}

export class ListCoachesQueryDto {
  @ApiPropertyOptional({
    description: 'Include coaches whose engagement has ended (default false)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class ResolvedCoachInviteView {
  @ApiProperty() valid!: boolean;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) trainerName!: string | null;
}
