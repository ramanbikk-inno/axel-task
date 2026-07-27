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
  ListCoachOverridesQuery,
  PagedCoachOverrides,
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
    return this.availability.getForProfile(req.user as Principal, profileId);
  }

  @Put(':profileId/availability')
  @HttpCode(200)
  @ApiOkResponse({ type: [AvailabilitySlotView] })
  async set(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: SetAvailabilityDto,
    @Req() req: Request,
  ): Promise<AvailabilitySlotView[]> {
    return this.availability.setForProfile(req.user as Principal, profileId, dto.slots);
  }
}

/** "My Times" — a coach manages their own weekly availability. */
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
    return this.availability.setForCoach(req.user as Principal, dto.slots);
  }

  /** A coach can see every override filed against them. */
  @Get('availability/overrides')
  @HttpCode(200)
  @ApiOkResponse({ type: PagedCoachOverrides })
  async listOverrides(
    @Query() query: ListCoachOverridesQuery,
    @Req() req: Request,
  ): Promise<PagedCoachOverrides> {
    return this.overrides.listForCoach((req.user as Principal).userId, query);
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

  /** Advisory only: a conflict never blocks the assignment, it just warns. */
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

/** The override audit trail. */
@ApiTags('availability')
@Controller('coach-overrides')
@UseGuards(JwtAuthGuard, RolesGuard)
// RolesGuard allows a request when it finds no @Roles metadata at all, so the
// class-level decorator keeps a new handler from defaulting to wide open.
@Roles(Role.Trainer, Role.SuperAdmin)
@ApiBearerAuth()
export class CoachOverridesController {
  constructor(private readonly overrides: CoachOverridesService) {}

  // A Super Admin does not run an organisation's schedule: read, not write.
  @Post()
  @HttpCode(201)
  @Roles(Role.Trainer)
  @ApiCreatedResponse({ type: CoachOverrideView })
  async record(
    @Body() dto: RecordCoachOverrideDto,
    @Req() req: Request,
  ): Promise<CoachOverrideView> {
    return this.overrides.record(req.user as Principal, dto);
  }

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: PagedCoachOverrides })
  async list(
    @Query() query: ListCoachOverridesQuery,
    @Req() req: Request,
  ): Promise<PagedCoachOverrides> {
    const principal = req.user as Principal;
    // A Super Admin has no trainer profile, so they get the platform-wide trail.
    return principal.role === Role.SuperAdmin
      ? this.overrides.listAll(query)
      : this.overrides.listForTrainer(principal.userId, query);
  }
}
