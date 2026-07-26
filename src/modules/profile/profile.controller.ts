import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { MyProfileView } from './dto/my-profile.view';
import {
  UpdatePlayerProfileDto,
  UpdateProfileDto,
  UpdateTrainerProfileDto,
  UploadPhotoDto,
} from './dto/profile.dto';
import { ProfileService } from './profile.service';

@ApiTags('profile')
@Controller('profile')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('me')
  @HttpCode(200)
  @ApiOkResponse({ type: MyProfileView })
  async getMe(@Req() req: Request): Promise<MyProfileView> {
    return this.profile.getMe((req.user as Principal).userId);
  }

  @Patch('me')
  @HttpCode(200)
  @ApiOkResponse({ type: MyProfileView })
  async updateMe(@Body() dto: UpdateProfileDto, @Req() req: Request): Promise<MyProfileView> {
    return this.profile.updateCommon(req.user as Principal, dto);
  }

  @Post('me/photo')
  @HttpCode(200)
  @ApiOkResponse({ type: MyProfileView })
  async uploadPhoto(@Body() dto: UploadPhotoDto, @Req() req: Request): Promise<MyProfileView> {
    return this.profile.uploadPhoto(req.user as Principal, dto);
  }

  @Delete('me/photo')
  @HttpCode(200)
  @ApiOkResponse({ type: MyProfileView })
  async removePhoto(@Req() req: Request): Promise<MyProfileView> {
    return this.profile.removePhoto(req.user as Principal);
  }

  @Patch('me/trainer')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.Trainer)
  @ApiOkResponse({ type: MyProfileView })
  async updateTrainer(
    @Body() dto: UpdateTrainerProfileDto,
    @Req() req: Request,
  ): Promise<MyProfileView> {
    return this.profile.updateTrainer(req.user as Principal, dto);
  }

  /**
   * The account holder's own trainee profile. NotAChildGuard because a child
   * shares the PlayerParent role but has no self profile of its own.
   */
  @Patch('me/player')
  @HttpCode(200)
  @UseGuards(RolesGuard, NotAChildGuard)
  @Roles(Role.PlayerParent)
  @ApiOkResponse({ type: MyProfileView })
  async updatePlayer(
    @Body() dto: UpdatePlayerProfileDto,
    @Req() req: Request,
  ): Promise<MyProfileView> {
    return this.profile.updatePlayer(req.user as Principal, dto);
  }
}
