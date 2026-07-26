import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';
import { IsPhoneNumberLoose } from '../../../shared/validation/phone';
import { IsOptionalNotNull } from '../../../shared/validation/presence';

/**
 * Section 8 leaves the shape open ("Emergency contact info"), and nothing
 * queries into it, so it is stored as jsonb. Validated all the same: it is
 * third-party PII and ends up in front of a trainer in an emergency, so an
 * unbounded blob is not good enough.
 */
export class EmergencyContactDto {
  @ApiPropertyOptional({ example: 'Jane Smith' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;

  @ApiPropertyOptional({ example: 'Grandmother' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relationship?: string;
}

/**
 * Amend a child profile (US-01.03 / US-01.11).
 *
 * Every field is optional and only the ones present are written, so a client
 * sending one key cannot blank the rest. `skillLevel` is deliberately absent:
 * section 8 says the trainer sets it, not the parent.
 *
 * The split between `@IsOptionalNotNull` and `@IsOptional` below is the
 * difference between a field a parent may clear and one they may not, and it
 * has to match the entity's own nullability — see the note on
 * `IsOptionalNotNull`.
 */
export class UpdateChildDto {
  @ApiPropertyOptional({ example: 'Maya Smith' })
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ example: '2014-08-01', description: 'Age must remain 1-18' })
  @IsOptionalNotNull()
  @IsCalendarDate()
  birthDate?: string;

  /** Mandatory at creation, so it cannot be cleared afterwards either. */
  @ApiPropertyOptional({ example: 'female' })
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  gender?: string;

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

  @ApiPropertyOptional({ type: EmergencyContactDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergencyContact?: EmergencyContactDto | null;
}
