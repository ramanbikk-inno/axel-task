import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AuthService } from './auth.service';
import { AuthTokens } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SetupPasswordDto } from './dto/setup-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Principal } from './principal';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  @ApiOkResponse({ type: MessageResponseDto })
  register(@Body() dto: RegisterDto): Promise<{ message: string }> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthTokens> {
    return this.authService.login(dto, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60000 }, ip: { limit: 60, ttl: 60000 } })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<AuthTokens> {
    return this.authService.refresh(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * Intentionally unauthenticated. Possession of a valid refresh token is the
   * authorisation — requiring an access token as well would leave a user whose
   * access token has expired unable to revoke their own session, and the
   * refresh token is a signed JWT, so it cannot be guessed.
   */
  @Post('logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60000 }, ip: { limit: 60, ttl: 60000 } })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('verify-email')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    await this.authService.verifyEmail(dto.token);
    return { message: 'Email verified. You can now log in.' };
  }

  @Post('resend-verification')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60000 }, ip: { limit: 10, ttl: 60000 } })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    await this.authService.resendVerification(dto.email);
    return { message: 'If the account exists and is unverified, an email was sent.' };
  }

  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60000 }, ip: { limit: 10, ttl: 60000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto.email);
    return { message: 'If the account exists, a reset email was sent.' };
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword({ token: dto.token, newPassword: dto.newPassword });
    return { message: 'Password reset. Please log in with your new password.' };
  }

  @Patch('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  // Authenticated, but still throttled: the current-password field makes this
  // an online oracle for a password an attacker holding a stolen access token
  // does not yet know.
  @Throttle({ default: { limit: 5, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  @ApiBearerAuth()
  async changePassword(
    @Req() req: Request,
    @Body() dto: ChangePasswordDto,
  ): Promise<AuthTokens & { message: string }> {
    const principal = req.user as Principal;
    const tokens = await this.authService.changePassword(
      principal,
      { currentPassword: dto.currentPassword, newPassword: dto.newPassword },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    // All previous sessions are now revoked, so the caller must swap in these
    // tokens to stay signed in.
    return { ...tokens, message: 'Password changed.' };
  }

  @Post('setup-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 }, ip: { limit: 20, ttl: 60000 } })
  async setupPassword(@Body() dto: SetupPasswordDto, @Req() req: Request): Promise<AuthTokens> {
    return this.authService.setupPassword(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Get('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@Req() req: Request): Principal {
    return req.user as Principal;
  }
}
