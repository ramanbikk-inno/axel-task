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
import { AssignmentsService } from './assignments.service';
import {
  AssignCoachDto,
  CreateEventDto,
  EventAssignmentView,
  EventView,
  RequestAssignmentChangeDto,
} from './dto/event.dto';
import { AssignmentResponse } from './entities/event-coach-assignment.entity';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('trainers/me/events')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Trainer)
@ApiBearerAuth()
export class TrainerEventsController {
  constructor(
    private readonly events: EventsService,
    private readonly assignments: AssignmentsService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOkResponse({ type: EventView })
  async create(@Body() dto: CreateEventDto, @Req() req: Request): Promise<EventView> {
    return this.events.create(req.user as Principal, dto);
  }

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [EventView] })
  async list(@Req() req: Request): Promise<EventView[]> {
    return this.events.listForTrainer((req.user as Principal).userId);
  }

  /**
   * Assign a coach. A conflict answers 409 COACH_UNAVAILABLE with the warning
   * to show; resending with `overrideReason` records the override and assigns.
   */
  @Post(':eventId/coaches')
  @HttpCode(201)
  @ApiOkResponse({ type: EventAssignmentView })
  async assign(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: AssignCoachDto,
    @Req() req: Request,
  ): Promise<EventAssignmentView> {
    return this.assignments.assign(req.user as Principal, eventId, dto);
  }

  @Get(':eventId/coaches')
  @HttpCode(200)
  @ApiOkResponse({ type: [EventAssignmentView] })
  async listAssignments(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Req() req: Request,
  ): Promise<EventAssignmentView[]> {
    return this.assignments.listForEvent((req.user as Principal).userId, eventId);
  }

  @Delete(':eventId/coaches/:coachProfileId')
  @HttpCode(204)
  async unassign(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('coachProfileId', ParseUUIDPipe) coachProfileId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.assignments.unassign(req.user as Principal, eventId, coachProfileId);
  }
}

/** The coach's side: see what you were scheduled for, accept, or ask to change. */
@ApiTags('events')
@Controller('coaches/me/assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Coach)
@ApiBearerAuth()
export class CoachAssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [EventAssignmentView] })
  async list(@Req() req: Request): Promise<EventAssignmentView[]> {
    return this.assignments.listForCoach((req.user as Principal).userId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: EventAssignmentView })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<EventAssignmentView> {
    return this.assignments.respond(req.user as Principal, id, AssignmentResponse.Accepted);
  }

  @Post(':id/request-change')
  @HttpCode(200)
  @ApiOkResponse({ type: EventAssignmentView })
  async requestChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestAssignmentChangeDto,
    @Req() req: Request,
  ): Promise<EventAssignmentView> {
    return this.assignments.respond(
      req.user as Principal,
      id,
      AssignmentResponse.ChangeRequested,
      dto,
    );
  }
}
