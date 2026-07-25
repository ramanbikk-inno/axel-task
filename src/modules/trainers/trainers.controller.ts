import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ErrorCode } from '../../shared/errors/error-codes';
import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { BrandingView, UpdateBrandingDto, UploadLogoDto } from './dto/branding.dto';
import { TrainerProfile } from './entities/trainer-profile.entity';
import { TrainersService } from './trainers.service';

function toBranding(profile: TrainerProfile): BrandingView {
  return {
    trainerProfileId: profile.id,
    businessName: profile.businessName,
    logoUrl: profile.logoUrl,
    primaryColor: profile.primaryColor,
  };
}

@ApiTags('trainers')
@Controller('trainers')
export class TrainersController {
  constructor(private readonly trainers: TrainersService) {}

  @Get('me/branding')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: BrandingView })
  async myBranding(@Req() req: Request): Promise<BrandingView> {
    const profile = await this.trainers.findByUserId((req.user as Principal).userId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      });
    }
    return toBranding(profile);
  }

  @Patch('me/branding')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: BrandingView })
  async updateBranding(@Body() dto: UpdateBrandingDto, @Req() req: Request): Promise<BrandingView> {
    const profile = await this.trainers.setPrimaryColor(
      (req.user as Principal).userId,
      dto.primaryColor,
    );
    return toBranding(profile);
  }

  @Post('me/logo')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: BrandingView })
  async uploadLogo(@Body() dto: UploadLogoDto, @Req() req: Request): Promise<BrandingView> {
    const profile = await this.trainers.setLogoFromUpload((req.user as Principal).userId, dto);
    return toBranding(profile);
  }

  @Delete('me/logo')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Trainer)
  @ApiBearerAuth()
  @ApiOkResponse({ type: BrandingView })
  async removeLogo(@Req() req: Request): Promise<BrandingView> {
    const profile = await this.trainers.removeLogo((req.user as Principal).userId);
    return toBranding(profile);
  }

  // Any authenticated user can read a trainer's branding to render the portal.
  @Get(':id/branding')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: BrandingView })
  async brandingById(@Param('id', ParseUUIDPipe) id: string): Promise<BrandingView> {
    const profile = await this.trainers.findById(id);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'Trainer not found.',
      });
    }
    return toBranding(profile);
  }
}
