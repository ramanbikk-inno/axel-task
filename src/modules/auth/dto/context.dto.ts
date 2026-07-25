import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SwitchContextDto {
  @ApiProperty({ format: 'uuid', description: 'One of your own or your children’s profiles' })
  @IsUUID('4')
  playerProfileId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'A trainer that profile is actively associated with',
  })
  @IsUUID('4')
  trainerProfileId!: string;
}

export class ContextOptionView {
  @ApiProperty({ format: 'uuid' }) playerProfileId!: string;
  @ApiProperty() playerDisplayName!: string;
  /** Drives the "Your Training" / "Your Children's Training" split in the selector. */
  @ApiProperty() isChild!: boolean;
  @ApiProperty({ format: 'uuid' }) trainerProfileId!: string;
  @ApiProperty() trainerBusinessName!: string;
}

export class ContextView {
  @ApiProperty({ type: ContextOptionView, nullable: true })
  active!: ContextOptionView | null;

  @ApiProperty({ type: [ContextOptionView] })
  options!: ContextOptionView[];
}

/**
 * A switch changes the token's tenant claims, so the caller is handed a new
 * access token. The refresh token is untouched — the session is the same one.
 */
export class SwitchContextResultView {
  @ApiProperty({ type: ContextOptionView })
  active!: ContextOptionView;

  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  expiresIn!: number;
}
