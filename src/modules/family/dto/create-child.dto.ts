import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';

/**
 * Create a child player profile. `birthDate` encodes the child's
 * age, which must resolve to 1–18 years; trainerProfileIds optionally connects
 * the child to trainers the parent is already associated with.
 */
export class CreateChildDto {
  @ApiProperty({ example: 'Maya Smith' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({
    example: '2014-08-01',
    description: 'Calendar date (YYYY-MM-DD), no time component; age must be 1-18',
  })
  @IsCalendarDate()
  birthDate!: string;

  @ApiProperty({ example: 'female' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  gender!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  school?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  jerseyNumber?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Trainer profile ids to connect the child to (must be trainers the parent has).',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  trainerProfileIds?: string[];
}
