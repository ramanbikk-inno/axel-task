import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { CampSubmissionsService } from './camp-submissions.service';
import {
  CampSubmissionPrefillView,
  CampSubmissionView,
  ConvertCampSubmissionDto,
  CreateCampSubmissionDto,
} from './dto/camp-submission.dto';
import { JoinResult } from './join.service';

/**
 * The submitter's side, all public: they have no account yet — that is the
 * point of the flow.
 */
@ApiTags('camp-submissions')
@Controller()
export class CampSubmissionsController {
  constructor(private readonly submissions: CampSubmissionsService) {}

  /** Throttled like the other public write paths: it takes free-text and email. */
  @Post('camps/:code/submissions')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  @ApiOkResponse({ type: CampSubmissionPrefillView })
  async submit(
    @Param('code') code: string,
    @Body() dto: CreateCampSubmissionDto,
  ): Promise<CampSubmissionPrefillView> {
    return this.submissions.submit(code, dto);
  }

  @Get('camp-submissions/:token')
  @HttpCode(200)
  @ApiOkResponse({ type: CampSubmissionPrefillView })
  async prefill(@Param('token') token: string): Promise<CampSubmissionPrefillView> {
    return this.submissions.prefill(token);
  }

  @Post('camp-submissions/:token/register')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  async convert(
    @Param('token') token: string,
    @Body() dto: ConvertCampSubmissionDto,
  ): Promise<JoinResult> {
    return this.submissions.convert(token, dto);
  }
}

/** The trainer's side: who filled the form in, and who never came back. */
@ApiTags('camp-submissions')
@Controller('trainers/me/camp-submissions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Trainer)
@ApiBearerAuth()
export class TrainerCampSubmissionsController {
  constructor(private readonly submissions: CampSubmissionsService) {}

  @Get()
  @HttpCode(200)
  @ApiOkResponse({ type: [CampSubmissionView] })
  async list(@Req() req: Request): Promise<CampSubmissionView[]> {
    return this.submissions.listForTrainer((req.user as Principal).userId);
  }

  @Post(':id/send-sharelink')
  @HttpCode(200)
  @ApiOkResponse({ type: CampSubmissionView })
  async sendShareLink(@Param('id') id: string, @Req() req: Request): Promise<CampSubmissionView> {
    return this.submissions.sendShareLink(req.user as Principal, id);
  }
}
