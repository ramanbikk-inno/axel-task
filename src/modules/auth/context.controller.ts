import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { Role } from '../users/entities/user.enums';
import { ContextOption, ContextService } from './context.service';
import {
  ContextOptionView,
  ContextView,
  SwitchContextDto,
  SwitchContextResultView,
} from './dto/context.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Principal } from './principal';
import { TokenService } from './token.service';

/**
 * Multi-trainer players see separated views (spec section 9): the client picks
 * a context, and everything downstream is scoped to it. Restricted to
 * PlayerParent because that is the only role whose tenancy is a choice —
 * a Coach's comes from their employer and a Trainer's from their own org.
 */
@ApiTags('auth')
@Controller('auth/context')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PlayerParent)
@ApiBearerAuth()
export class ContextController {
  constructor(
    private readonly context: ContextService,
    private readonly tokens: TokenService,
  ) {}

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: ContextView })
  async current(@Req() req: Request): Promise<ContextView> {
    const principal = req.user as Principal;
    const options = await this.context.listOptions(principal);
    const active =
      options.find(
        (o) =>
          o.playerProfileId === principal.activePlayerProfileId &&
          o.trainerProfileId === principal.activeTrainerProfileId,
      ) ?? null;
    return { active, options };
  }

  @Post('switch')
  @HttpCode(200)
  @ApiOkResponse({ type: SwitchContextResultView })
  async switch(
    @Body() dto: SwitchContextDto,
    @Req() req: Request,
  ): Promise<SwitchContextResultView> {
    const principal = req.user as Principal;
    const selected = await this.context.switch(principal, {
      playerProfileId: dto.playerProfileId,
      trainerProfileId: dto.trainerProfileId,
    });

    // Re-read the label from the options the caller is allowed to see rather
    // than echoing the request back, so the response cannot be made to name a
    // profile the switch did not actually select.
    const options = await this.context.listOptions(principal);
    const active = options.find(
      (o) =>
        o.playerProfileId === selected.playerProfileId &&
        o.trainerProfileId === selected.trainerProfileId,
    ) as ContextOption;

    // The tenant claims changed, so the old access token is stale. Only the
    // access token is reissued: it is the same session, so the refresh token
    // and its rotation family stay exactly as they were.
    const accessToken = this.tokens.signAccess({
      userId: principal.userId,
      role: principal.role,
      sessionId: principal.sessionId,
      activeTrainerProfileId: selected.trainerProfileId,
      trainerOrgId: principal.trainerOrgId,
      tokenVersion: principal.tokenVersion,
      actorUserId: principal.actor?.userId,
    });

    return { active, accessToken, expiresIn: this.tokens.accessTtlSeconds() };
  }

  @Delete()
  @HttpCode(200)
  @ApiOkResponse({ type: SwitchContextResultView })
  async clear(@Req() req: Request): Promise<{ accessToken: string; expiresIn: number }> {
    const principal = req.user as Principal;
    await this.context.clear(principal);

    const accessToken = this.tokens.signAccess({
      userId: principal.userId,
      role: principal.role,
      sessionId: principal.sessionId,
      activeTrainerProfileId: null,
      trainerOrgId: principal.trainerOrgId,
      tokenVersion: principal.tokenVersion,
      actorUserId: principal.actor?.userId,
    });

    return { accessToken, expiresIn: this.tokens.accessTtlSeconds() };
  }
}

export type { ContextOptionView };
