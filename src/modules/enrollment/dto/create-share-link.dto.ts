import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ShareLinkType } from '../entities/share-link.entity';

export class CreateShareLinkDto {
  @ApiPropertyOptional({
    enum: [ShareLinkType.PlayerStatic],
    default: ShareLinkType.PlayerStatic,
    description: 'Only static player links are supported here (coach links: US-01.08).',
  })
  @IsOptional()
  @IsEnum(ShareLinkType)
  type?: ShareLinkType;
}
