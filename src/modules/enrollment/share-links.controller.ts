import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { CreateShareLinkDto } from './dto/create-share-link.dto';
import { ShareLink } from './entities/share-link.entity';
import { ResolvedShareLink, ShareLinksService } from './share-links.service';

interface ShareLinkView {
  id: string;
  code: string;
  type: string;
  url: string;
  useCount: number;
  active: boolean;
  createdAt: Date;
}

@ApiTags('sharelinks')
@Controller()
export class ShareLinksController {
  private readonly appUrl: string;

  constructor(
    private readonly shareLinks: ShareLinksService,
    config: ConfigService,
  ) {
    this.appUrl = config.get<string>('APP_URL') ?? 'http://localhost:3000';
  }

  private toView(link: ShareLink): ShareLinkView {
    return {
      id: link.id,
      code: link.code,
      type: link.type,
      url: `${this.appUrl}/join/${link.code}`,
      useCount: link.useCount,
      active: link.active,
      createdAt: link.createdAt,
    };
  }

  @Post('sharelinks')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  async create(@Body() _dto: CreateShareLinkDto, @Req() req: Request): Promise<ShareLinkView> {
    // The body is validated (and rejects anything but player_static) but carries
    // no choice: this endpoint only ever mints a static player link.
    const link = await this.shareLinks.createForTrainer(req.user as Principal);
    return this.toView(link);
  }

  @Get('sharelinks')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  async list(@Req() req: Request): Promise<ShareLinkView[]> {
    const links = await this.shareLinks.listForTrainer(req.user as Principal);
    return links.map((l) => this.toView(l));
  }

  // Public: resolve a link so the join page can show the trainer name.
  @Get('sharelinks/:code')
  @HttpCode(200)
  async resolve(@Param('code') code: string): Promise<ResolvedShareLink> {
    return this.shareLinks.resolve(code);
  }
}
