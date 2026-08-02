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
import { CoachInvitationService } from './coach-invitation.service';
import { CoachProfileService } from './coach-profile.service';
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
  constructor(
    private readonly invitations: CoachInvitationService,
    private readonly profiles: CoachProfileService,
  ) {}

  @Post('invitations')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachInvitationView })
  async invite(@Body() dto: InviteCoachDto, @Req() req: Request): Promise<CoachInvitationView> {
    return this.invitations.invite(req.user as Principal, dto);
  }

  @Get('invitations')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: [CoachInvitationView] })
  async listInvitations(@Req() req: Request): Promise<CoachInvitationView[]> {
    return this.invitations.listInvitations(req.user as Principal);
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
    return this.profiles.listCoaches(req.user as Principal, query.includeInactive ?? false);
  }

  /** Resend an invitation whose link expired. */
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
    return this.invitations.resendInvitation(req.user as Principal, id);
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
    return this.invitations.revokeInvitation(req.user as Principal, id);
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
    return this.profiles.offboardCoach(req.user as Principal, id);
  }

  /**
   * The trainer's publicly-listed coaches. Not role-gated — anyone in the
   * organisation may see who coaches there — but scoped to its members.
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
    return this.profiles.listPublicCoaches(req.user as Principal, trainerProfileId);
  }

  /** A coach edits their own profile. */
  @Get('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Coach)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachView })
  async getOwnProfile(@Req() req: Request): Promise<CoachView> {
    return this.profiles.getOwnProfile(req.user as Principal);
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
    return this.profiles.updateOwnProfile(req.user as Principal, dto);
  }

  // Public: resolve an invite for the accept page.
  @Get('invitations/:code')
  @HttpCode(200)
  @ApiOkResponse({ type: ResolvedCoachInviteView })
  async resolve(@Param('code') code: string): Promise<ResolvedCoachInviteView> {
    return this.invitations.resolve(code);
  }

  // Public: a new coach accepts the invitation and sets a password.
  @Post('invitations/:code/accept')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async accept(
    @Param('code') code: string,
    @Body() dto: AcceptCoachInviteDto,
  ): Promise<{ message: string }> {
    return this.invitations.accept(code, dto);
  }
}
