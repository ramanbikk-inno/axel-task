import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { displayNameFor } from '../../shared/format/display-name';
import { ageInYears, parseCalendarDate } from '../../shared/validation/calendar-date';
import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { ImpersonationLogService } from '../impersonation/impersonation-log.service';
import { MailService } from '../mail/mail.service';
import { PlayersService } from '../players/players.service';
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
import { Principal } from './principal';
import { TokenService } from './token.service';

const REGISTER_MESSAGE = 'Registration received. Check your email to verify your account.';

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
    private readonly impersonationLogs: ImpersonationLogService,
    private readonly playersService: PlayersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Minors cannot hold an account in their own name; they belong to a parent's
   * account as a child profile. Threshold is MIN_SELF_REGISTRATION_AGE, default
   * 18. Every door onto an own-name account calls this — both registration
   * paths and the edit that can move a birth date afterwards.
   */
  assertOldEnoughForOwnAccount(birthDate: string): void {
    const born = parseCalendarDate(birthDate);
    if (born === null) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate must be a calendar date in YYYY-MM-DD format.',
      });
    }

    const now = this.clock.now();
    if (born.getTime() > now.getTime()) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate cannot be in the future.',
      });
    }

    const minimumAge = this.config.get<number>('MIN_SELF_REGISTRATION_AGE') ?? 18;
    if (ageInYears(born, now) < minimumAge) {
      throw new ForbiddenException({
        errorCode: ErrorCode.UNDERAGE_SELF_REGISTRATION,
        message: `You must be at least ${minimumAge} to create your own account. Ask a parent to add you to their account.`,
      });
    }
  }

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
      // Verify against a real argon2id dummy hash so timing matches the found path.
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

    // Login is the only moment we hold the plaintext, so it is the only chance to
    // rehash under stronger argon2 parameters. Not setPasswordAndBumpVersion:
    // the password did not change, and bumping would sign the user out everywhere.
    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.usersService.updatePasswordHash(user.id, await this.passwords.hash(dto.password));
    }

    const pair = await this.issueTokensForSession(user, meta);
    await this.usersService.touchLastLogin(user.id, this.clock.now());

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds(),
    };
  }

  async register(dto: RegisterDto): Promise<{ message: string }> {
    // Before the existence check, or the response tells the caller whether the
    // address is already taken.
    this.assertOldEnoughForOwnAccount(dto.birthDate);

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

    // The birth date is collected to run the age check above, so it has to be
    // kept: the self profile is the only place that holds one, and nothing
    // downstream can ask the registrant again. This mirrors the ShareLink
    // registration path, which has always created the profile here.
    await this.playersService.create({
      ownerUserId: user.id,
      displayName: displayNameFor(user, user.email),
      isChild: false,
      birthDate: dto.birthDate,
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

    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid verification token.',
      });
    }
    this.assertAccountUsable(user);

    await this.emailVerifications.update({ id: row.id }, { consumedAt: now });
    await this.usersService.markEmailVerified(row.userId, now);

    await this.mail.sendWelcomeEmail(user.email, user.firstName ?? '');
  }

  /** A token issued while the account was healthy must not survive its deactivation. */
  private assertAccountUsable(user: User): void {
    if (user.status === UserStatus.Deleted) {
      throw new ForbiddenException({
        errorCode: ErrorCode.ACCOUNT_DELETED,
        message: 'This account has been deleted.',
      });
    }
    if (user.status !== UserStatus.Active) {
      throw new ForbiddenException({
        errorCode: ErrorCode.ACCOUNT_INACTIVE,
        message: 'This account is inactive. Contact support.',
      });
    }
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    // Silent no-op rather than an error, to stay enumeration-safe. Deactivated and
    // deleted accounts get none: verification no longer reactivates, and an erased
    // account's address is now `deleted_<id>@example.com`.
    if (!user || user.emailVerified || user.status !== UserStatus.Active) {
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

    // Hard session expiry — impersonation sessions are capped at an hour.
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
      expiresIn: this.tokens.accessTtlSeconds(),
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
    // Logging out ends an impersonation as surely as /impersonation/exit does;
    // without this the audit row stays open forever.
    await this.impersonationLogs.closeForSession(row.sessionId, now);
  }

  /** Revoke every active session and refresh token. Historical rows are kept. */
  async revokeAllUserSessions(userId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: reason },
    );
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: now });
    // Any of those sessions may have been an admin impersonating this user. The
    // impersonated user owns the session, so they are the log's target.
    await this.impersonationLogs.closeForTargetUser(userId, now);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || user.status !== UserStatus.Active) {
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

  /**
   * Takes the principal because this must refuse to run inside an impersonation:
   * it mints a fresh non-impersonated session, which would silently upgrade a
   * capped supervised session into a durable login as the target. The
   * current-password check is not a safeguard — the admin may have just set it.
   */
  async changePassword(
    principal: Principal,
    input: { currentPassword: string; newPassword: string },
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    if (principal.impersonating) {
      throw new ForbiddenException({
        errorCode: ErrorCode.FORBIDDEN_DURING_IMPERSONATION,
        message: 'Passwords cannot be changed while impersonating a user.',
      });
    }

    const userId = principal.userId;
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

    // A password change is the standard remediation for a stolen session, so it
    // has to drop every existing one. The caller gets a fresh pair so they are
    // not signed out by their own change.
    await this.revokeAllUserSessions(userId, 'password-change');

    // Re-read so the new tokens carry the bumped tokenVersion.
    const refreshed = (await this.usersService.findById(userId)) as User;
    const pair = await this.issueTokensForSession(refreshed, meta);

    await this.mail.sendPasswordChangedEmail(user.email);

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds(),
    };
  }

  /**
   * Create an unverified PlayerParent account inside the caller's transaction.
   * Returns the plaintext token so the email is sent only after it commits.
   */
  async createUnverifiedPlayer(
    input: {
      email: string;
      password: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
    manager: EntityManager,
  ): Promise<{ user: User; verificationToken: string }> {
    return this.createUnverifiedAccount({ ...input, role: Role.PlayerParent }, manager);
  }

  /**
   * As above, for any role. Used by the ShareLink join and coach-invite flows.
   */
  async createUnverifiedAccount(
    input: {
      email: string;
      password: string;
      role: Role;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
    manager: EntityManager,
  ): Promise<{ user: User; verificationToken: string }> {
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.usersService.create(
      {
        email: input.email,
        role: input.role,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        emailVerified: false,
        mustSetPassword: false,
        status: UserStatus.Active,
      },
      manager,
    );

    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 24 * 60 * 60 * 1000);
    const evRepo = manager.getRepository(EmailVerificationToken);
    await evRepo.save(evRepo.create({ userId: user.id, tokenHash, consumedAt: null, expiresAt }));

    return { user, verificationToken: token };
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
    this.assertAccountUsable(user);

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
      expiresIn: this.tokens.accessTtlSeconds(),
    };
  }
}
