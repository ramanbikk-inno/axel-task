import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { AssignmentResponse } from '../entities/event-coach-assignment.entity';

export class CreateEventDto {
  @ApiProperty({ example: 'Tuesday skills session' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: '2026-09-01T17:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ example: '2026-09-01T19:00:00.000Z' })
  @IsISO8601()
  endsAt!: string;

  @ApiPropertyOptional({ description: 'Price in minor units. Null for a free session.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({ description: 'Cost in tokens, if the session is token-payable.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceTokens?: number;
}

export class EventView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) trainerProfileId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() startsAt!: Date;
  @ApiProperty() endsAt!: Date;
  @ApiProperty({ nullable: true }) priceCents!: number | null;
  @ApiProperty({ nullable: true }) priceTokens!: number | null;
  @ApiProperty() createdAt!: Date;
}

export class AssignCoachDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  coachProfileId!: string;

  /**
   * Required only when the coach is not free for the event's window: the first
   * call comes back with COACH_UNAVAILABLE and the warning to show, and the
   * trainer repeats it with a reason. "Trainer can override with reason
   * (text field required)".
   */
  @ApiPropertyOptional({ description: 'Reason for scheduling the coach outside their times.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  overrideReason?: string;
}

export class RequestAssignmentChangeDto {
  @ApiPropertyOptional({ description: 'What the coach would like changed.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class EventAssignmentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty() eventTitle!: string;
  @ApiProperty() startsAt!: Date;
  @ApiProperty() endsAt!: Date;
  @ApiProperty({ format: 'uuid' }) coachProfileId!: string;
  @ApiProperty({ enum: AssignmentResponse }) response!: AssignmentResponse;
  @ApiProperty({ nullable: true }) coachNote!: string | null;
  @ApiProperty({ description: 'The assignment went against the coach’s stated times.' })
  hadConflict!: boolean;
  @ApiProperty({ nullable: true, format: 'uuid' }) overrideId!: string | null;
  @ApiProperty() assignedAt!: Date;
  @ApiProperty({ nullable: true }) respondedAt!: Date | null;
}
