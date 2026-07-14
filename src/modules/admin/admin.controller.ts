import {
  Body,
  Controller,
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
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { UserStatusChangeDto } from './dto/user-status-change.dto';
import { PaginatedUsersDto, UserSummaryDto } from './dto/user-summary.dto';

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

  @Post(':id/deactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, 'User'))
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async deactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserStatusChangeDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.deactivateUser(id, principal.userId, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, 'User'))
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async reactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserStatusChangeDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.reactivateUser(id, principal.userId, dto.reason);
  }

  @Patch(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, PoliciesGuard)
  @Roles(Role.SuperAdmin)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, 'User'))
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.updateUser(id, principal.userId, dto);
  }
}
