import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * US-01.02: "If Parent with Children: Show selection prompt — 'Who will train
 * with [New Trainer]?' … Only selected family members associated with new
 * trainer."
 *
 * Optional, so the existing single-player flow keeps working unchanged: a
 * caller who sends nothing joins with their own profile, which is what
 * happened before this field existed.
 */
export class JoinMembersDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Which of your own profiles join this trainer. Defaults to your own.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  playerProfileIds?: string[];
}

export class EligibleMemberView {
  @ApiProperty({ format: 'uuid' }) playerProfileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() isChild!: boolean;
  /** Already with this trainer, so the client can pre-tick and disable it. */
  @ApiProperty() alreadyAssociated!: boolean;
}

export class JoinMembersPromptView {
  @ApiProperty() trainerProfileId!: string;
  @ApiProperty() trainerName!: string;
  @ApiProperty({ type: [EligibleMemberView] })
  members!: EligibleMemberView[];
}
