import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
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

  @ApiPropertyOptional({
    default: true,
    description: 'false marks a blackout window that subtracts from availability',
  })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
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
  @ApiProperty() isAvailable!: boolean;
}

export class PlayerAvailabilityView {
  @ApiProperty() playerProfileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: [AvailabilitySlotView] })
  slots!: AvailabilitySlotView[];
}

export class CoachAvailabilityView {
  @ApiProperty() coachProfileId!: string;
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

/** The proposed assignment window a trainer wants to check a coach against. */
export class ConflictCheckQuery {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sunday .. 6=Saturday' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '16:00' })
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @ApiProperty({ example: '18:00' })
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;
}

export class ConflictCheckView {
  @ApiProperty({ description: 'true when the coach is available for the whole requested window' })
  available!: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Warning to show the trainer before they override; null when available',
  })
  message!: string | null;

  @ApiProperty({
    type: [AvailabilitySlotView],
    description: "The coach's windows on the requested day, for context",
  })
  daySlots!: AvailabilitySlotView[];
}

export class RecordCoachOverrideDto {
  @ApiProperty()
  @IsUUID()
  coachProfileId!: string;

  @ApiPropertyOptional({
    description: 'The event being scheduled. Optional until Epic-02 introduces events.',
  })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiProperty({ minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '16:00' })
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @ApiProperty({ example: '18:00' })
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;

  @ApiProperty({ minLength: 5, maxLength: 1000, description: 'Required (US-01.10)' })
  // Trimmed first so a whitespace-only reason fails validation here rather
  // than hitting the CHK_coach_availability_overrides_reason constraint.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  overrideReason!: string;
}

export class ListCoachOverridesQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class CoachOverrideView {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) eventId!: string | null;
  @ApiProperty() coachProfileId!: string;
  @ApiProperty() trainerProfileId!: string;
  @ApiProperty() dayOfWeek!: number;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty() overrideReason!: string;

  @ApiProperty({
    description:
      'Whether the window actually conflicted with the coach schedule when recorded. False means nothing was overridden.',
  })
  hadConflict!: boolean;

  @ApiProperty() overriddenByUserId!: string;
  @ApiProperty() createdAt!: Date;
}

export class PagedCoachOverrides {
  @ApiProperty({ type: [CoachOverrideView] }) items!: CoachOverrideView[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
