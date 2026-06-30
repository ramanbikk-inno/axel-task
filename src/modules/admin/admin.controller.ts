import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Action, AppAbility } from '../ability/ability.factory';
import { CheckPolicies } from '../ability/check-policies.decorator';
import { PoliciesGuard } from '../ability/policies.guard';
import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Role } from '../users/entities/user.enums';
import { AdminService } from './admin.service';
import { CreateTrainerDto } from './dto/create-trainer.dto';

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
  ): Promise<{ id: string; email: string; role: Role }> {
    return this.adminService.createTrainer(dto);
  }
}
