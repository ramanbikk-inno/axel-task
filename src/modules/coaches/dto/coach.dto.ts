import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  IsStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../shared/validation/password';
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
  @ApiProperty() publicVisible!: boolean;
  @ApiProperty({ enum: ['Active', 'Inactive'] }) status!: CoachStatus;
  @ApiProperty() joinedAt!: Date;
  @ApiProperty({ nullable: true }) endedAt!: Date | null;
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
