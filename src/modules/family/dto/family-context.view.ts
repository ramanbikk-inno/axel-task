import { ApiProperty } from '@nestjs/swagger';

import { PlayerProfileView } from './player-profile.view';

/**
 * Context-switcher data: the account holder's own trainee context
 * plus each child's contexts, so the client can render "Your Training" and
 * "Your Children's Training" sections.
 */
export class FamilyContextView {
  @ApiProperty({ type: PlayerProfileView, nullable: true })
  self!: PlayerProfileView | null;

  @ApiProperty({ type: [PlayerProfileView] })
  children!: PlayerProfileView[];
}
