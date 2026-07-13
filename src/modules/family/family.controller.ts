import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AddTrainerByCodeDto, AddTrainerDto } from './dto/add-trainer.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { FamilyContextView } from './dto/family-context.view';
import { PlayerProfileView } from './dto/player-profile.view';
import { FamilyService } from './family.service';

@ApiTags('family')
@Controller('players')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PlayerParent)
@ApiBearerAuth()
export class FamilyController {
  constructor(private readonly family: FamilyService) {}

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [PlayerProfileView] })
  async list(@Req() req: Request): Promise<PlayerProfileView[]> {
    const principal = req.user as Principal;
    return this.family.listFamily(principal.userId);
  }

  @Get('context')
  @HttpCode(200)
  @ApiOkResponse({ type: FamilyContextView })
  async context(@Req() req: Request): Promise<FamilyContextView> {
    const principal = req.user as Principal;
    return this.family.getContext(principal.userId);
  }

  @Post('children')
  @HttpCode(201)
  @ApiOkResponse({ type: PlayerProfileView })
  async createChild(@Body() dto: CreateChildDto, @Req() req: Request): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.createChild(principal.userId, dto);
  }

  @Post(':profileId/trainers')
  @HttpCode(200)
  @ApiOkResponse({ type: PlayerProfileView })
  async addTrainer(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: AddTrainerDto,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.addTrainerFromExisting(principal.userId, profileId, dto.trainerProfileId);
  }

  @Post(':profileId/trainers/by-code')
  @HttpCode(200)
  @ApiOkResponse({ type: PlayerProfileView })
  async addTrainerByCode(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: AddTrainerByCodeDto,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.addTrainerByCode(principal.userId, profileId, dto.code);
  }

  @Delete(':profileId/trainers/:trainerProfileId')
  @HttpCode(200)
  @ApiOkResponse({ type: PlayerProfileView })
  async removeTrainer(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Param('trainerProfileId', ParseUUIDPipe) trainerProfileId: string,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.removeTrainer(principal.userId, profileId, trainerProfileId);
  }
}
