import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';
import { IsPhoneNumberLoose } from '../../../shared/validation/phone';
import { IsOptionalNotNull } from '../../../shared/validation/presence';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;
}

export class UploadPhotoDto {
  @ApiProperty({ example: 'avatar.png' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fileName!: string;

  @ApiProperty({ enum: IMAGE_TYPES })
  @IsIn(IMAGE_TYPES)
  mimeType!: string;

  @ApiProperty({ description: 'Base64-encoded image data (max 2MB decoded)' })
  @IsString()
  @MinLength(1)
  dataBase64!: string;
}

export class UpdateTrainerProfileDto {
  /** An organisation has to be called something, so this one cannot be cleared. */
  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  businessName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class UpdatePlayerProfileDto {
  /** The one field on a profile that must always hold a value. */
  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  school?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  jerseyNumber?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string | null;

  /** Not clearable: the minimum-age rule has nothing to check against a null. */
  @ApiPropertyOptional({ example: '1994-03-22', description: 'Date of birth (YYYY-MM-DD)' })
  @IsOptionalNotNull()
  @IsCalendarDate()
  birthDate?: string;
}
