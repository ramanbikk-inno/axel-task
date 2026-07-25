import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { AssociationStatus } from '../entities/trainer-player-association.entity';

/**
 * A trainer's view of one player in their organisation — "Player profile
 * created in trainer's CRM" (US-01.02).
 *
 * The parent's contact details are here because for a child the parent *is*
 * the contact: the trainer has to be able to reach someone about a minor, and
 * a child profile carries no email or phone of its own.
 */
export class RosterEntryView {
  @ApiProperty({ format: 'uuid' }) playerProfileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() isChild!: boolean;
  @ApiPropertyOptional({ nullable: true }) birthDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) gender!: string | null;
  @ApiPropertyOptional({ nullable: true }) skillLevel!: string | null;
  @ApiPropertyOptional({ nullable: true }) school!: string | null;
  @ApiPropertyOptional({ nullable: true }) jerseyNumber!: string | null;

  @ApiProperty({ format: 'uuid' }) accountUserId!: string;
  @ApiPropertyOptional({ nullable: true }) accountEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) accountName!: string | null;
  @ApiPropertyOptional({ nullable: true }) accountPhone!: string | null;

  @ApiProperty({ enum: AssociationStatus }) status!: AssociationStatus;
  @ApiProperty() connectedAt!: Date;
}

export class RosterQueryDto {
  @ApiPropertyOptional({ description: 'Match on player or account name/email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Include players who have disconnected' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
