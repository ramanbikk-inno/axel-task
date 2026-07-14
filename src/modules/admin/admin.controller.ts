import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Action, AppAbility } from '../ability/ability.factory';
import { CheckPolicies } from '../ability/check-policies.decorator';
import { PoliciesGuard } from '../ability/policies.guard';
import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AdminService } from './admin.service';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { PaginatedUsersDto } from './dto/user-summary.dto';

@ApiTags('admin')
@Controller('users')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, 'User'))
  @ApiBearerAuth()
  async createTrainer(
    @Body() dto: CreateTrainerDto,
    @Req() req: Request,
  ): Promise<{ id: string; email: string; role: Role }> {
    const principal = req.user as Principal;
    return this.adminService.createTrainer(dto, principal.userId);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, 'User'))
  @ApiBearerAuth()
  @ApiOkResponse({ type: PaginatedUsersDto })
  async listUsers(@Query() query: ListUsersQueryDto): Promise<PaginatedUsersDto> {
    return this.adminService.listUsers(query);
  }
}
