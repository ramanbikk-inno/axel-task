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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotAChildGuard } from '../auth/guards/not-a-child.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AddTrainerByCodeDto, AddTrainerDto } from './dto/add-trainer.dto';
import { ChildLoginStatusView, ChildLoginView, CreateChildLoginDto } from './dto/child-login.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { UpdateChildDto } from './dto/update-child.dto';
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
    return this.family.listFamily(principal);
  }

  @Get('context')
  @HttpCode(200)
  @ApiOkResponse({ type: FamilyContextView })
  async context(@Req() req: Request): Promise<FamilyContextView> {
    const principal = req.user as Principal;
    return this.family.getContext(principal);
  }

  @Post('children')
  @HttpCode(201)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PlayerProfileView })
  async createChild(@Body() dto: CreateChildDto, @Req() req: Request): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.createChild(principal, dto);
  }

  /** Amend a child profile (US-01.03 / US-01.11). Parent-only. */
  @Patch('children/:profileId')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PlayerProfileView })
  async updateChild(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: UpdateChildDto,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.updateChild(principal, profileId, dto);
  }

  /**
   * Give a child profile its own login (US-01.06). Parent-only: a child holding
   * one must not be able to mint another, for a sibling or for themselves.
   */
  @Post('children/:profileId/login')
  @HttpCode(201)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: ChildLoginView })
  async createChildLogin(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: CreateChildLoginDto,
    @Req() req: Request,
  ): Promise<ChildLoginView> {
    const principal = req.user as Principal;
    return this.family.createChildLogin(principal, profileId, dto);
  }

  @Get('children/:profileId/login')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: ChildLoginStatusView })
  async childLoginStatus(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Req() req: Request,
  ): Promise<ChildLoginStatusView> {
    const principal = req.user as Principal;
    return this.family.childLoginStatus(principal.userId, profileId);
  }

  @Delete('children/:profileId/login')
  @HttpCode(204)
  @UseGuards(NotAChildGuard)
  async revokeChildLogin(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Req() req: Request,
  ): Promise<void> {
    const principal = req.user as Principal;
    await this.family.revokeChildLogin(principal, profileId);
  }

  @Post(':profileId/trainers')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PlayerProfileView })
  async addTrainer(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: AddTrainerDto,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.addTrainerFromExisting(principal, profileId, dto.trainerProfileId);
  }

  @Post(':profileId/trainers/by-code')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PlayerProfileView })
  async addTrainerByCode(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() dto: AddTrainerByCodeDto,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.addTrainerByCode(principal, profileId, dto.code);
  }

  @Delete(':profileId/trainers/:trainerProfileId')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PlayerProfileView })
  async removeTrainer(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Param('trainerProfileId', ParseUUIDPipe) trainerProfileId: string,
    @Req() req: Request,
  ): Promise<PlayerProfileView> {
    const principal = req.user as Principal;
    return this.family.removeTrainer(principal, profileId, trainerProfileId);
  }
}
