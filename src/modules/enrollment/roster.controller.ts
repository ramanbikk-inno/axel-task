import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RosterEntryView, RosterQueryDto, UpdateRosterEntryDto } from './dto/roster.dto';
import { RosterService } from './roster.service';

@ApiTags('roster')
@Controller()
export class RosterController {
  constructor(private readonly rosterService: RosterService) {}

  /** The trainer's view of everyone connected to them. */
  @Get('trainers/me/roster')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: [RosterEntryView] })
  async roster(@Query() query: RosterQueryDto, @Req() req: Request): Promise<RosterEntryView[]> {
    return this.rosterService.list(req.user as Principal, query);
  }

  /** Skill level is the trainer's assessment, not the player's. */
  @Patch('trainers/me/roster/:playerProfileId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: RosterEntryView })
  async updateRosterEntry(
    @Param('playerProfileId', ParseUUIDPipe) playerProfileId: string,
    @Body() dto: UpdateRosterEntryDto,
    @Req() req: Request,
  ): Promise<RosterEntryView> {
    return this.rosterService.setSkillLevel(
      req.user as Principal,
      playerProfileId,
      dto.skillLevel ?? null,
    );
  }

  /** Off-board a player from this trainer's roster. */
  @Delete('trainers/me/roster/:playerProfileId')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  async removeRosterEntry(
    @Param('playerProfileId', ParseUUIDPipe) playerProfileId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.rosterService.remove(req.user as Principal, playerProfileId);
  }
}
