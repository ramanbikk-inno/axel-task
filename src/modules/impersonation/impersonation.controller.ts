import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { Action, AppAbility } from '../ability/ability.factory';
import { CheckPolicies } from '../ability/check-policies.decorator';
import { PoliciesGuard } from '../ability/policies.guard';
import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { ImpersonateDto } from './dto/impersonate.dto';
import {
  ImpersonationHistoryQueryDto,
  ImpersonationHistoryView,
} from './dto/impersonation-history.dto';
import { ImpersonationService, StartImpersonationResult } from './impersonation.service';

@ApiTags('impersonation')
@Controller('users')
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post(':id/impersonate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Impersonate, 'User'))
  // Assuming another user's identity is the single most sensitive action on the
  // platform. A rate limit bounds how much of the user table one compromised
  // admin token can be walked through before anyone notices.
  @Throttle({ default: { limit: 10, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  @ApiBearerAuth()
  async impersonate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ImpersonateDto,
    @Req() req: Request,
  ): Promise<StartImpersonationResult> {
    const principal = req.user as Principal;
    return this.impersonation.start(
      principal,
      id,
      { ip: req.ip, userAgent: req.headers['user-agent'] },
      dto.reason,
    );
  }

  @Post('impersonation/exit')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async exit(@Req() req: Request): Promise<{ message: string }> {
    await this.impersonation.exit(req.user as Principal);
    return { message: 'Exited impersonation.' };
  }

  /** US-01.07: "Audit report available: Impersonation History for compliance". */
  @Get('impersonation/history')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiOkResponse({ type: ImpersonationHistoryView })
  @ApiBearerAuth()
  async history(@Query() query: ImpersonationHistoryQueryDto): Promise<ImpersonationHistoryView> {
    return this.impersonation.history(query);
  }

  @Get('impersonation/context')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async context(
    @Req() req: Request,
  ): Promise<{ impersonating: boolean; adminUserId?: string; target?: unknown }> {
    return this.impersonation.banner(req.user as Principal);
  }
}
