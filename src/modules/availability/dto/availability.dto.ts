import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Time-of-day in 24h HH:MM, confined to a single calendar day (00:00–23:59).
// Availability windows do not cross midnight: endTime must be strictly after
// startTime and both fall on the same day, so a window cannot end at 24:00.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class AvailabilitySlotInput {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sunday .. 6=Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '17:00' })
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @ApiProperty({ example: '20:00' })
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;
}

export class SetAvailabilityDto {
  @ApiProperty({ type: [AvailabilitySlotInput] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotInput)
  slots!: AvailabilitySlotInput[];
}

export class AvailabilitySlotView {
  @ApiProperty() dayOfWeek!: number;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
}

export class PlayerAvailabilityView {
  @ApiProperty() playerProfileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: [AvailabilitySlotView] })
  slots!: AvailabilitySlotView[];
}

export class TrainerAvailabilityQuery {
  @ApiPropertyOptional({ minimum: 0, maximum: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'time must be HH:MM (24h)' })
  time?: string;
}
