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
import { IsOptionalNotNull } from '../../../shared/validation/presence';
import { EmergencyContactDto } from '../../players/dto/emergency-contact.dto';

export { EmergencyContactDto };

/**
 * Only the fields present are written, so sending one key cannot blank the rest.
 * `skillLevel` is absent on purpose: the trainer sets it, not the parent.
 * `@IsOptionalNotNull` vs `@IsOptional` marks which fields a parent may clear.
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
