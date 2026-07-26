import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { ShareLinkType } from '../entities/share-link.entity';

export class CreateShareLinkDto {
  @ApiPropertyOptional({
    enum: [ShareLinkType.PlayerStatic],
    default: ShareLinkType.PlayerStatic,
    description: 'Only static player links are supported here.',
  })
  @IsOptional()
  // Deliberately narrower than the ShareLinkType enum. Accepting coach_unique
  // here minted an invite with no target email, no expiry and no use limit —
  // the opposite of what a coach invite needs.
  @IsIn([ShareLinkType.PlayerStatic])
  type?: ShareLinkType.PlayerStatic;
}
