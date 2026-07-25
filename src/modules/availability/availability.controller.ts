import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AvailabilityService } from './availability.service';
import { CoachOverridesService } from './coach-overrides.service';
import {
  AvailabilitySlotView,
  CoachAvailabilityView,
  CoachOverrideView,
  ConflictCheckQuery,
  ConflictCheckView,
  PlayerAvailabilityView,
  RecordCoachOverrideDto,
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

/** "My Times" — a coach manages their own weekly availability (US-01.10). */
@ApiTags('availability')
@Controller('coaches/me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Coach)
@ApiBearerAuth()
export class CoachAvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly overrides: CoachOverridesService,
  ) {}

  @Get('availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [AvailabilitySlotView] })
  async get(@Req() req: Request): Promise<AvailabilitySlotView[]> {
    return this.availability.getForCoach((req.user as Principal).userId);
  }

  @Put('availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [AvailabilitySlotView] })
  async set(@Body() dto: SetAvailabilityDto, @Req() req: Request): Promise<AvailabilitySlotView[]> {
    return this.availability.setForCoach((req.user as Principal).userId, dto.slots);
  }

  /** The coach's side of Q-01.06: they can see every override filed against them. */
  @Get('availability/overrides')
  @HttpCode(200)
  @ApiOkResponse({ type: [CoachOverrideView] })
  async listOverrides(@Req() req: Request): Promise<CoachOverrideView[]> {
    return this.overrides.listForCoach((req.user as Principal).userId);
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

  @Get('me/coaches/:coachProfileId/availability')
  @HttpCode(200)
  @ApiOkResponse({ type: CoachAvailabilityView })
  async coachAvailability(
    @Param('coachProfileId', ParseUUIDPipe) coachProfileId: string,
    @Req() req: Request,
  ): Promise<CoachAvailabilityView> {
    return this.availability.coachViewForTrainer((req.user as Principal).userId, coachProfileId);
  }

  /**
   * Advisory only. A conflict never blocks the assignment — it tells the
   * trainer what warning to show and whether a reason will be required.
   */
  @Get('me/coaches/:coachProfileId/availability/conflict-check')
  @HttpCode(200)
  @ApiOkResponse({ type: ConflictCheckView })
  async conflictCheck(
    @Param('coachProfileId', ParseUUIDPipe) coachProfileId: string,
    @Query() query: ConflictCheckQuery,
    @Req() req: Request,
  ): Promise<ConflictCheckView> {
    return this.availability.checkCoachConflict(
      (req.user as Principal).userId,
      coachProfileId,
      query,
    );
  }
}

/** The override audit trail itself (US-01.10 "Override logged"). */
@ApiTags('availability')
@Controller('coach-overrides')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Trainer)
@ApiBearerAuth()
export class CoachOverridesController {
  constructor(private readonly overrides: CoachOverridesService) {}

  @Post()
  @HttpCode(201)
  @ApiCreatedResponse({ type: CoachOverrideView })
  async record(
    @Body() dto: RecordCoachOverrideDto,
    @Req() req: Request,
  ): Promise<CoachOverrideView> {
    return this.overrides.record((req.user as Principal).userId, dto);
  }

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [CoachOverrideView] })
  async list(@Req() req: Request): Promise<CoachOverrideView[]> {
    return this.overrides.listForTrainer((req.user as Principal).userId);
  }
}
