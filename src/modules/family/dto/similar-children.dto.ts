import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';

/**
 * Preflight for "+ Add Child": what the parent is about to type, so the UI can
 * warn before the create call rather than after a 409.
 */
export class SimilarChildrenQueryDto {
  @ApiProperty({ example: 'Alex Smith' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @ApiPropertyOptional({ example: '2014-08-01' })
  @IsOptional()
  @IsCalendarDate()
  birthDate?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Profile being renamed, so it does not match itself.',
  })
  @IsOptional()
  @IsUUID('4')
  excludeProfileId?: string;
}

export class SimilarChildView {
  @ApiProperty({ format: 'uuid' }) profileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true }) birthDate!: string | null;
  @ApiProperty({
    description:
      'Same name and birth date — creating this is refused unless allowDuplicate is set.',
  })
  exact!: boolean;
}

export class SimilarChildrenView {
  @ApiProperty({ type: [SimilarChildView] }) matches!: SimilarChildView[];
  @ApiProperty({ description: 'At least one match is an exact name + birth date collision.' })
  hasExactMatch!: boolean;
}
