import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  ListCoachesQueryDto,
  PublicCoachView,
  ResolvedCoachInviteView,
  UpdateCoachProfileDto,
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
  async listCoaches(
    @Query() query: ListCoachesQueryDto,
    @Req() req: Request,
  ): Promise<CoachView[]> {
    return this.coaches.listCoaches(req.user as Principal, query.includeInactive ?? false);
  }

  /** US-01.08: "Link expires: Clear message, option to resend invitation". */
  @Post('invitations/:id/resend')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachInvitationView })
  async resendInvitation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: Request,
  ): Promise<CoachInvitationView> {
    return this.coaches.resendInvitation(req.user as Principal, id);
  }

  @Delete('invitations/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachInvitationView })
  async revokeInvitation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: Request,
  ): Promise<CoachInvitationView> {
    return this.coaches.revokeInvitation(req.user as Principal, id);
  }

  /** End a coach's engagement. The row survives; the access does not. */
  @Delete(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachView })
  async offboard(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: Request,
  ): Promise<CoachView> {
    return this.coaches.offboardCoach(req.user as Principal, id);
  }

  /**
   * The trainer's publicly-listed coaches, as their players and parents see
   * them. Not role-gated — everyone inside an organisation may see who coaches
   * there — but scoped to that organisation's members, so authentication alone
   * does not open one org's staff list to another's.
   */
  @Get('public/:trainerProfileId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: [PublicCoachView] })
  async listPublic(
    @Param('trainerProfileId', ParseUUIDPipe) trainerProfileId: string,
    @Req() req: Request,
  ): Promise<PublicCoachView[]> {
    return this.coaches.listPublicCoaches(req.user as Principal, trainerProfileId);
  }

  /** Spec section 6: a coach "may edit their own profile and availability". */
  @Get('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Coach)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachView })
  async getOwnProfile(@Req() req: Request): Promise<CoachView> {
    return this.coaches.getOwnProfile(req.user as Principal);
  }

  @Patch('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Coach)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachView })
  async updateOwnProfile(
    @Body() dto: UpdateCoachProfileDto,
    @Req() req: Request,
  ): Promise<CoachView> {
    return this.coaches.updateOwnProfile(req.user as Principal, dto);
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
