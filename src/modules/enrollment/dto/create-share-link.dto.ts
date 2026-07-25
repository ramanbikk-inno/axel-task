import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { ShareLinkType } from '../entities/share-link.entity';

export class CreateShareLinkDto {
  @ApiPropertyOptional({
    enum: [ShareLinkType.PlayerStatic],
    default: ShareLinkType.PlayerStatic,
    description: 'Only static player links are supported here (coach links: US-01.08).',
  })
  @IsOptional()
  // Deliberately narrower than the ShareLinkType enum. Accepting coach_unique
  // here minted an invite with no target email, no expiry and no use limit —
  // the opposite of what US-01.08 requires of a coach invite.
  @IsIn([ShareLinkType.PlayerStatic])
  type?: ShareLinkType.PlayerStatic;
}
