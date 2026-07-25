import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotAChildGuard } from '../auth/guards/not-a-child.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { JoinMembersDto, JoinMembersPromptView } from './dto/join-members.dto';
import { JoinRegisterDto } from './dto/join-register.dto';
import { EnrollmentService, JoinResult } from './enrollment.service';

@ApiTags('join')
@Controller('join')
export class JoinController {
  constructor(private readonly enrollment: EnrollmentService) {}

  // Public: new player/parent registers via a trainer's ShareLink.
  @Post(':code/register')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async register(@Param('code') code: string, @Body() dto: JoinRegisterDto): Promise<JoinResult> {
    return this.enrollment.registerViaShareLink(code, dto);
  }

  /** US-01.02: "Who will train with [New Trainer]?" — the selection prompt. */
  @Get(':code/members')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, NotAChildGuard)
  @Roles(Role.PlayerParent)
  @ApiBearerAuth()
  @ApiOkResponse({ type: JoinMembersPromptView })
  async members(@Param('code') code: string, @Req() req: Request): Promise<JoinMembersPromptView> {
    return this.enrollment.eligibleMembers(code, req.user as Principal);
  }

  // Authenticated: an existing player joins another trainer (multi-trainer),
  // optionally naming which family members come with them.
  @Post(':code')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.PlayerParent)
  @ApiBearerAuth()
  async join(
    @Param('code') code: string,
    @Body() dto: JoinMembersDto,
    @Req() req: Request,
  ): Promise<JoinResult> {
    return this.enrollment.joinAsExistingPlayer(code, req.user as Principal, dto.playerProfileIds);
  }
}
