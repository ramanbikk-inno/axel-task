import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
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
import { Role } from '../users/entities/user.enums';
import { AvailabilityService } from './availability.service';
import {
  AvailabilitySlotView,
  PlayerAvailabilityView,
  SetAvailabilityDto,
  TrainerAvailabilityQuery,
} from './dto/availability.dto';

@ApiTags('availability')
@Controller('players')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PlayerParent)
@ApiBearerAuth()
export class PlayerAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get(':profileId/availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [AvailabilitySlotView] })
  async get(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Req() req: Request,
  ): Promise<AvailabilitySlotView[]> {
    return this.availability.getForProfile((req.user as Principal).userId, profileId);
  }

  @Put(':profileId/availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [AvailabilitySlotView] })
  async set(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: SetAvailabilityDto,
    @Req() req: Request,
  ): Promise<AvailabilitySlotView[]> {
    return this.availability.setForProfile((req.user as Principal).userId, profileId, dto.slots);
  }
}

@ApiTags('availability')
@Controller('trainers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Trainer)
@ApiBearerAuth()
export class TrainerAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('me/players/availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [PlayerAvailabilityView] })
  async view(
    @Query() query: TrainerAvailabilityQuery,
    @Req() req: Request,
  ): Promise<PlayerAvailabilityView[]> {
    return this.availability.trainerView((req.user as Principal).userId, query);
  }
}
