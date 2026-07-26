import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * Which family members join the new trainer. Optional: a caller who sends
 * nothing joins with their own profile, as the single-player flow always did.
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
