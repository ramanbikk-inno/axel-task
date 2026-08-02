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
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { CoachView, UpdateCoachProfileDto } from '../coaches/dto/coach.dto';
import { UpdatePlayerProfileDto, UpdateTrainerProfileDto } from '../profile/dto/profile.dto';
import { Role } from '../users/entities/user.enums';
import { AdminService } from './admin.service';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import {
  AdminPlayerProfileView,
  AdminTrainerProfileView,
  AdminUserDetailView,
} from './dto/admin-profile.view';
import { CreateTrainerDto } from './dto/create-trainer.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { DeleteUserDto, UserStatusChangeDto } from './dto/user-status-change.dto';
import { PaginatedUsersDto, UserSummaryDto } from './dto/user-summary.dto';

// User CRUD here is SuperAdmin-only, and a SuperAdmin's ability is an
// unconditional `manage all` — a CASL check on top of RolesGuard can never fail.
@ApiTags('admin')
@Controller('users')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  async createTrainer(
    @Body() dto: CreateTrainerDto,
    @Req() req: Request,
  ): Promise<{ id: string; email: string; role: Role }> {
    const principal = req.user as Principal;
    return this.adminService.createTrainer(dto, principal);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: PaginatedUsersDto })
  async listUsers(@Query() query: ListUsersQueryDto): Promise<PaginatedUsersDto> {
    return this.adminService.listUsers(query);
  }

  @Get(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: AdminUserDetailView })
  async getUser(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDetailView> {
    return this.adminService.getUser(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async deactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserStatusChangeDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.deactivateUser(id, principal, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async reactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserStatusChangeDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.reactivateUser(id, principal, dto.reason);
  }

  @Patch(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.updateUser(id, principal, dto);
  }

  @Patch(':id/trainer-profile')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: AdminTrainerProfileView })
  async updateTrainerProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrainerProfileDto,
    @Req() req: Request,
  ): Promise<AdminTrainerProfileView> {
    const principal = req.user as Principal;
    return this.adminService.updateTrainerProfile(id, principal, dto);
  }

  @Patch(':id/coach-profile')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: CoachView })
  async updateCoachProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCoachProfileDto,
    @Req() req: Request,
  ): Promise<CoachView> {
    const principal = req.user as Principal;
    return this.adminService.updateCoachProfile(id, principal, dto);
  }

  @Patch(':id/player-profile')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: AdminPlayerProfileView })
  async updatePlayerProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlayerProfileDto,
    @Req() req: Request,
  ): Promise<AdminPlayerProfileView> {
    const principal = req.user as Principal;
    return this.adminService.updatePlayerProfile(id, principal, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserSummaryDto })
  async deleteUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteUserDto,
    @Req() req: Request,
  ): Promise<UserSummaryDto> {
    const principal = req.user as Principal;
    return this.adminService.deleteUser(id, principal, dto.reason);
  }
}
