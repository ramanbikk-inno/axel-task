import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  @ApiBearerAuth()
  async impersonate(
    @Param('id') id: string,
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
