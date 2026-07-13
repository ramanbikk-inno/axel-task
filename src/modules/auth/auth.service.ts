import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { AuthTokens, RefreshClaims } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AccountSetupToken } from './entities/account-setup-token.entity';
import { AuthSession } from './entities/auth-session.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { TokenService } from './token.service';

const REGISTER_MESSAGE = 'Registration received. Check your email to verify your account.';
const ACCESS_TTL_SECONDS = 900;

@Injectable()
export class AuthService {
  private dummyHash: string | null = null;

  constructor(
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(EmailVerificationToken)
    private readonly emailVerifications: Repository<EmailVerificationToken>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResets: Repository<PasswordResetToken>,
    @InjectRepository(AccountSetupToken)
    private readonly accountSetups: Repository<AccountSetupToken>,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly clock: ClockService,
    private readonly usersService: UsersService,
  ) {}

  private async getDummyHash(): Promise<string> {
    if (this.dummyHash === null) {
      this.dummyHash = await this.passwords.hash('dummy-password-for-constant-time-verification');
    }
    return this.dummyHash;
  }

  private async issueTokensForSession(
    user: User,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const session = await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        activeTrainerProfileId: null,
        createdAt: this.clock.now(),
        lastUsedAt: this.clock.now(),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        revokedAt: null,
        revokedReason: null,
      }),
    );

    const accessToken = this.tokens.signAccess({
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: user.tokenVersion,
    });

    const refresh = this.tokens.signRefresh({ userId: user.id, sessionId: session.id });

    await this.refreshTokens.save(
      this.refreshTokens.create({
        id: refresh.jti,
        sessionId: session.id,
        userId: user.id,
        familyId: refresh.familyId,
        tokenHash: this.tokens.hashOpaqueToken(refresh.token),
        expiresAt: refresh.expiresAt,
        revokedAt: null,
        replacedById: null,
      }),
    );

    return { accessToken, refreshToken: refresh.token };
  }

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<AuthTokens> {
    const user = await this.usersService.findByEmailWithPassword(dto.email);

    if (!user || user.passwordHash === null || user.passwordHash === undefined) {
      // Constant-time: verify against a real argon2id dummy hash so timing matches the found path.
      await this.passwords.verify(await this.getDummyHash(), dto.password);
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email or password.',
      });
    }

    const passwordValid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email or password.',
      });
    }

    if (user.status === UserStatus.Deleted) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email or password.',
      });
    }
    if (user.status === UserStatus.Inactive) {
      throw new ForbiddenException({
        errorCode: ErrorCode.ACCOUNT_INACTIVE,
        message: 'This account is inactive. Contact support.',
      });
    }
    if (user.mustSetPassword) {
      throw new ForbiddenException({
        errorCode: ErrorCode.SETUP_REQUIRED,
        message: 'You must set your password before logging in.',
      });
    }
    if (!user.emailVerified) {
      throw new ForbiddenException({
        errorCode: ErrorCode.EMAIL_NOT_VERIFIED,
        message: 'Verify your email address before logging in.',
      });
    }

    const pair = await this.issueTokensForSession(user, meta);
    await this.usersService.touchLastLogin(user.id, this.clock.now());

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  async register(dto: RegisterDto): Promise<{ message: string }> {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      // Enumeration-safe: no-op, never throw EMAIL_ALREADY_EXISTS here.
      return { message: REGISTER_MESSAGE };
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      role: Role.PlayerParent,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      emailVerified: false,
      mustSetPassword: false,
      status: UserStatus.Active,
    });

    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 24 * 60 * 60 * 1000);
    await this.emailVerifications.save(
      this.emailVerifications.create({ userId: user.id, tokenHash, consumedAt: null, expiresAt }),
    );
    await this.mail.sendVerificationEmail(user.email, token);

    return { message: REGISTER_MESSAGE };
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.tokens.hashOpaqueToken(token);
    const row = await this.emailVerifications.findOne({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid verification token.',
      });
    }
    if (row.consumedAt) {
      throw new ConflictException({
        errorCode: ErrorCode.TOKEN_ALREADY_USED,
        message: 'This verification token has already been used.',
      });
    }
    const now = this.clock.now();
    if (row.expiresAt.getTime() < now.getTime()) {
      throw new GoneException({
        errorCode: ErrorCode.EXPIRED_TOKEN,
        message: 'This verification token has expired.',
      });
    }

    await this.emailVerifications.update({ id: row.id }, { consumedAt: now });
    await this.usersService.markEmailVerified(row.userId, now);

    const user = await this.usersService.findById(row.userId);
    if (user) {
      await this.mail.sendWelcomeEmail(user.email, user.firstName ?? '');
    }
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || user.emailVerified) {
      return;
    }

    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 24 * 60 * 60 * 1000);
    await this.emailVerifications.save(
      this.emailVerifications.create({ userId: user.id, tokenHash, consumedAt: null, expiresAt }),
    );
    await this.mail.sendVerificationEmail(user.email, token);
  }

  async refresh(
    refreshToken: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const claims = this.tokens.verifyRefresh(refreshToken);

    const row = await this.refreshTokens.findOne({ where: { id: claims.jti } });
    if (!row) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Refresh token is invalid.',
      });
    }

    if (row.revokedAt !== null || row.replacedById !== null) {
      await this.refreshTokens.update({ familyId: row.familyId }, { revokedAt: this.clock.now() });
      throw new UnauthorizedException({
        errorCode: ErrorCode.TOKEN_REUSED,
        message: 'Refresh token reuse detected.',
      });
    }

    if (row.tokenHash !== this.tokens.hashOpaqueToken(refreshToken)) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Refresh token is invalid.',
      });
    }

    if (row.expiresAt.getTime() < this.clock.now().getTime()) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Refresh token has expired.',
      });
    }

    const session = await this.sessions.findOne({ where: { id: row.sessionId } });
    if (!session || session.revokedAt !== null) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Session is no longer active.',
      });
    }

    // Hard session expiry (e.g. impersonation sessions are capped at 1 hour).
    if (session.expiresAt && session.expiresAt.getTime() < this.clock.now().getTime()) {
      await this.sessions.update(
        { id: session.id },
        { revokedAt: this.clock.now(), revokedReason: 'expired' },
      );
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Session has expired.',
      });
    }

    const user = await this.usersService.findById(row.userId);
    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'User is not active.',
      });
    }

    const accessToken = this.tokens.signAccess({
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      activeTrainerProfileId: session.activeTrainerProfileId,
      trainerOrgId: null,
      tokenVersion: user.tokenVersion,
      actorUserId: session.impersonatedBy ?? undefined,
    });

    const newRefresh = this.tokens.signRefresh({
      userId: user.id,
      sessionId: session.id,
      familyId: row.familyId,
    });

    await this.refreshTokens.save(
      this.refreshTokens.create({
        id: newRefresh.jti,
        sessionId: session.id,
        userId: user.id,
        familyId: newRefresh.familyId,
        tokenHash: this.tokens.hashOpaqueToken(newRefresh.token),
        expiresAt: newRefresh.expiresAt,
        revokedAt: null,
        replacedById: null,
      }),
    );

    await this.refreshTokens.update(
      { id: row.id },
      { revokedAt: this.clock.now(), replacedById: newRefresh.jti },
    );

    session.lastUsedAt = this.clock.now();
    if (meta.ip !== undefined) {
      session.ip = meta.ip;
    }
    if (meta.userAgent !== undefined) {
      session.userAgent = meta.userAgent;
    }
    await this.sessions.save(session);

    return {
      accessToken,
      refreshToken: newRefresh.token,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    let claims: RefreshClaims;
    try {
      claims = this.tokens.verifyRefresh(refreshToken);
    } catch {
      return;
    }

    const row = await this.refreshTokens.findOne({ where: { id: claims.jti } });
    if (!row) {
      return;
    }

    const now = this.clock.now();
    await this.refreshTokens.update({ id: row.id }, { revokedAt: now });
    await this.sessions.update({ id: row.sessionId }, { revokedAt: now, revokedReason: 'logout' });
  }

  /**
   * Revoke every active session and refresh token for a user (e.g. when a
   * Super Admin deactivates the account). Historical rows are preserved.
   */
  async revokeAllUserSessions(userId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: reason },
    );
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: now });
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return;
    }

    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 60 * 60 * 1000);
    await this.passwordResets.save(
      this.passwordResets.create({ userId: user.id, tokenHash, consumedAt: null, expiresAt }),
    );
    await this.mail.sendPasswordResetEmail(user.email, token);
  }

  async resetPassword(input: { token: string; newPassword: string }): Promise<void> {
    const tokenHash = this.tokens.hashOpaqueToken(input.token);
    const row = await this.passwordResets.findOne({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid reset token.',
      });
    }
    if (row.consumedAt) {
      throw new ConflictException({
        errorCode: ErrorCode.TOKEN_ALREADY_USED,
        message: 'This reset token has already been used.',
      });
    }
    const now = this.clock.now();
    if (row.expiresAt.getTime() < now.getTime()) {
      throw new GoneException({
        errorCode: ErrorCode.EXPIRED_TOKEN,
        message: 'This reset token has expired.',
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.passwordResets.update({ id: row.id }, { consumedAt: now });
    await this.usersService.setPasswordAndBumpVersion(row.userId, passwordHash);
    await this.sessions.update(
      { userId: row.userId, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: 'password-reset' },
    );

    const user = await this.usersService.findById(row.userId);
    if (user) {
      await this.mail.sendPasswordChangedEmail(user.email);
    }
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    const ok = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!ok) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.usersService.setPasswordAndBumpVersion(userId, passwordHash);
    await this.mail.sendPasswordChangedEmail(user.email);
  }

  async createSetupToken(userId: string, manager?: EntityManager): Promise<string> {
    const repository =
      manager !== undefined ? manager.getRepository(AccountSetupToken) : this.accountSetups;
    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 72 * 60 * 60 * 1000);
    await repository.save(repository.create({ userId, tokenHash, consumedAt: null, expiresAt }));
    return token;
  }

  async setupPassword(
    input: { token: string; newPassword: string },
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const tokenHash = this.tokens.hashOpaqueToken(input.token);
    const row = await this.accountSetups.findOne({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid setup token.',
      });
    }
    if (row.consumedAt) {
      throw new ConflictException({
        errorCode: ErrorCode.TOKEN_ALREADY_USED,
        message: 'This setup token has already been used.',
      });
    }
    const now = this.clock.now();
    if (row.expiresAt.getTime() < now.getTime()) {
      throw new GoneException({
        errorCode: ErrorCode.EXPIRED_TOKEN,
        message: 'This setup token has expired.',
      });
    }

    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid setup token.',
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.accountSetups.update({ id: row.id }, { consumedAt: now });
    await this.usersService.setPasswordAndBumpVersion(user.id, passwordHash);
    await this.usersService.markEmailVerified(user.id, now);

    const refreshed = await this.usersService.findById(user.id);
    if (!refreshed) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid setup token.',
      });
    }

    const pair = await this.issueTokensForSession(refreshed, meta);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }
}
