import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { CoachesService } from './coaches.service';
import {
  AcceptCoachInviteDto,
  CoachInvitationView,
  CoachView,
  InviteCoachDto,
  ResolvedCoachInviteView,
} from './dto/coach.dto';

@ApiTags('coaches')
@Controller('coaches')
export class CoachesController {
  constructor(private readonly coaches: CoachesService) {}

  @Post('invitations')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachInvitationView })
  async invite(@Body() dto: InviteCoachDto, @Req() req: Request): Promise<CoachInvitationView> {
    return this.coaches.invite(req.user as Principal, dto);
  }

  @Get('invitations')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: [CoachInvitationView] })
  async listInvitations(@Req() req: Request): Promise<CoachInvitationView[]> {
    return this.coaches.listInvitations(req.user as Principal);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: [CoachView] })
  async listCoaches(@Req() req: Request): Promise<CoachView[]> {
    return this.coaches.listCoaches(req.user as Principal);
  }

  // Public: resolve an invite for the accept page.
  @Get('invitations/:code')
  @HttpCode(200)
  @ApiOkResponse({ type: ResolvedCoachInviteView })
  async resolve(@Param('code') code: string): Promise<ResolvedCoachInviteView> {
    return this.coaches.resolve(code);
  }

  // Public: a new coach accepts the invitation and sets a password.
  @Post('invitations/:code/accept')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async accept(
    @Param('code') code: string,
    @Body() dto: AcceptCoachInviteDto,
  ): Promise<{ message: string }> {
    return this.coaches.accept(code, dto);
  }
}
