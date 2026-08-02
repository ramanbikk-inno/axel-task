import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { UserStatus } from '../../users/entities/user.enums';
import { AssociationStatus } from '../entities/trainer-player-association.entity';

/**
 * A trainer's view of one player in their organisation — "Player profile
 * created in trainer's CRM".
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

  /**
   * The account's own status, distinct from `status` below, which is the
   * association. A Super Admin deactivation does not touch the association, so
   * without this the CRM has nothing to gray the row out by.
   */
  @ApiPropertyOptional({ enum: UserStatus, nullable: true })
  accountStatus!: UserStatus | null;

  @ApiProperty({ enum: AssociationStatus }) status!: AssociationStatus;
  @ApiProperty() connectedAt!: Date;
}

/**
 * Skill level is the trainer's to set and one of the fields a player may not
 * edit. The column existed from the start with no write path, so the roster
 * always reported null.
 */
export class UpdateRosterEntryDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'Intermediate',
    description: 'Free text; the vocabulary is not fixed yet. Null clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  skillLevel?: string | null;
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
