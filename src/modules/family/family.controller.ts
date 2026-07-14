import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { CreateChildDto } from './dto/create-child.dto';
import { PlayerProfileView } from './dto/player-profile.view';
import { FamilyService } from './family.service';

@ApiTags('family')
@Controller('players')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PlayerParent)
@ApiBearerAuth()
export class FamilyController {
  constructor(private readonly family: FamilyService) {}

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [PlayerProfileView] })
  async list(@Req() req: Request): Promise<PlayerProfileView[]> {
    const principal = req.user as Principal;
    return this.family.listFamily(principal.userId);
  }

  @Post('children')
  @HttpCode(201)
  @ApiOkResponse({ type: PlayerProfileView })
  async createChild(@Body() dto: CreateChildDto, @Req() req: Request): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.createChild(principal.userId, dto);
  }
}
