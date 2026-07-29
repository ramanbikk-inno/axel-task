import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { SESSION_IDLE_TIMEOUT_DEFAULT } from '../../shared/config/env.validation';
import { durationToSeconds } from '../../shared/config/duration';
import { displayNameFor } from '../../shared/format/display-name';
import { PasswordService } from '../../shared/crypto/password.service';
import { PG_UNIQUE_VIOLATION } from '../../shared/errors/all-exceptions.filter';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AgeGateService } from '../../shared/registration/age-gate.service';
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
import { SingleUseTokenService } from './single-use-token.service';
import { TokenService } from './token.service';

const REGISTER_MESSAGE = 'Registration received. Check your email to verify your account.';

/** The unique index behind users.email, as Postgres names it in a violation. */
const USERS_EMAIL_INDEX = 'uq_users_email';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const ACCOUNT_SETUP_TTL_MS = 72 * 60 * 60 * 1000;

/** Overrides `issueTokensForSession` accepts for a supervised (impersonation) session. */
export interface SessionOverrides {
  impersonatedBy?: string;
  actorUserId?: string;
  expiresAt?: Date;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private dummyHash: string | null = null;

  /** Parsed once, like the JWT TTLs: a malformed value must fail the boot, not every refresh. */
  private readonly idleTimeoutMs: number;

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
    private readonly singleUseTokens: SingleUseTokenService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly clock: ClockService,
    private readonly usersService: UsersService,
    private readonly impersonationLogs: ImpersonationLogService,
    private readonly playersService: PlayersService,
    private readonly ageGate: AgeGateService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.idleTimeoutMs =
      durationToSeconds(
        this.config.get<string>('SESSION_IDLE_TIMEOUT') ?? SESSION_IDLE_TIMEOUT_DEFAULT,
      ) * 1000;
  }

  private async getDummyHash(): Promise<string> {
    if (this.dummyHash === null) {
      this.dummyHash = await this.passwords.hash('dummy-password-for-constant-time-verification');
    }
    return this.dummyHash;
  }

  private toAuthTokens(pair: { accessToken: string; refreshToken: string }): AuthTokens {
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds(),
    };
  }

  /**
   * Mint a session + access/refresh token pair for `user`. Shared by an
   * ordinary login and by ImpersonationService.start, via `overrides` — a
   * supervised session sets `impersonatedBy`, `actorUserId` and the capped
   * `expiresAt`; an ordinary one leaves all three unset.
   */
  async issueTokensForSession(
    user: User,
    meta: { ip?: string; userAgent?: string },
    overrides: SessionOverrides = {},
  ): Promise<IssuedSession> {
    const session = await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        activeTrainerProfileId: null,
        impersonatedBy: overrides.impersonatedBy ?? null,
        expiresAt: overrides.expiresAt ?? null,
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
      actorUserId: overrides.actorUserId,
    });

    const refresh = this.tokens.signRefresh({
      userId: user.id,
      sessionId: session.id,
      notAfter: overrides.expiresAt,
    });

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

    return { sessionId: session.id, accessToken, refreshToken: refresh.token };
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

    return this.toAuthTokens(pair);
  }

  async register(dto: RegisterDto): Promise<{ message: string }> {
    // Before the existence check, or the response tells the caller whether the
    // address is already taken.
    this.ageGate.assertOldEnoughForOwnAccount(dto.birthDate);

    // Before the existence check, not just before the transaction: hashing only
    // for free addresses makes a taken one answer ~40ms faster.
    const passwordHash = await this.passwords.hash(dto.password);

    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      // Enumeration-safe: no-op, never throw EMAIL_ALREADY_EXISTS here.
      return { message: REGISTER_MESSAGE };
    }

    // Two concurrent registrations of one address both pass the read above; the
    // loser hits uq_users_email, and a 409 would reveal the address is taken.
    let created: { email: string; verificationToken: string };
    try {
      created = await this.registerInTransaction(dto, passwordHash);
    } catch (error) {
      const driver = error as { code?: string; constraint?: string };
      // Narrowed to the email index: any other unique collision is a real fault
      // and must not be reported as a successful registration.
      if (driver.code === PG_UNIQUE_VIOLATION && driver.constraint === USERS_EMAIL_INDEX) {
        return { message: REGISTER_MESSAGE };
      }
      throw error;
    }

    // After the commit: the mail provider is not transactional, and an outage
    // there must not undo an account that already exists.
    await this.mail.sendVerificationEmail(created.email, created.verificationToken);

    return { message: REGISTER_MESSAGE };
  }

  /**
   * All three writes or none. A half-finished registration leaves an account that
   * can never verify itself, and loses the birth date nothing asks for again.
   */
  private async registerInTransaction(
    dto: RegisterDto,
    passwordHash: string,
  ): Promise<{ email: string; verificationToken: string }> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { user, verificationToken } = await this.createUnverifiedAccount(
        {
          email: dto.email,
          passwordHash,
          role: Role.PlayerParent,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        },
        manager,
      );

      await this.playersService.create(
        {
          ownerUserId: user.id,
          displayName: displayNameFor(user, user.email),
          isChild: false,
          birthDate: dto.birthDate,
        },
        manager,
      );

      return { email: user.email, verificationToken };
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await this.singleUseTokens.validate(this.emailVerifications, token, {
      invalid: 'Invalid verification token.',
      alreadyUsed: 'This verification token has already been used.',
      expired: 'This verification token has expired.',
    });

    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid verification token.',
      });
    }
    this.assertAccountUsable(user);

    const now = this.clock.now();
    await this.singleUseTokens.markConsumed(this.emailVerifications, row.id, now);
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

    const token = await this.singleUseTokens.issue(
      this.emailVerifications,
      user.id,
      EMAIL_VERIFICATION_TTL_MS,
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
      const now = this.clock.now();
      await this.refreshTokens.update({ familyId: row.familyId }, { revokedAt: now });
      // Reuse means the family is compromised, not just this one token — kill
      // the session too, or an access token already minted from the thief's
      // successful rotation stays live until its own exp.
      //
      // Only a session that is still live, though. A replay long after the
      // session already ended must not restate when it ended: SessionValidator
      // already rejects both revoked and expired sessions, so there is nothing
      // left to revoke, and `revoked_at` is what reconcileOpenLogs reads to date
      // an impersonation — moving it would report a duration past the 1h cap and
      // would relabel an ordinary logout as a theft.
      const revoked = await this.sessions
        .createQueryBuilder()
        .update(AuthSession)
        .set({ revokedAt: now, revokedReason: 'token-reuse' })
        .where('id = :id', { id: row.sessionId })
        .andWhere('revoked_at IS NULL')
        .andWhere('(expires_at IS NULL OR expires_at > :now)', { now })
        .execute();
      if (revoked.affected) {
        await this.impersonationLogs.closeForSession(row.sessionId, now);
      }
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

    // Ordinary use bumps lastUsedAt roughly every JWT_ACCESS_TTL; a wider gap means idle.
    if (session.lastUsedAt !== null) {
      if (this.clock.now().getTime() - session.lastUsedAt.getTime() > this.idleTimeoutMs) {
        await this.sessions.update(
          { id: session.id },
          { revokedAt: this.clock.now(), revokedReason: 'idle-timeout' },
        );
        throw new UnauthorizedException({
          errorCode: ErrorCode.REFRESH_TOKEN_INVALID,
          message: 'Session has been idle too long. Please log in again.',
        });
      }
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

    return this.toAuthTokens({ accessToken, refreshToken: newRefresh.token });
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

    const token = await this.singleUseTokens.issue(
      this.passwordResets,
      user.id,
      PASSWORD_RESET_TTL_MS,
    );
    await this.mail.sendPasswordResetEmail(user.email, token);
  }

  async resetPassword(input: { token: string; newPassword: string }): Promise<void> {
    const row = await this.singleUseTokens.validate(this.passwordResets, input.token, {
      invalid: 'Invalid reset token.',
      alreadyUsed: 'This reset token has already been used.',
      expired: 'This reset token has expired.',
    });

    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.clock.now();
    await this.singleUseTokens.markConsumed(this.passwordResets, row.id, now);
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

    return this.toAuthTokens(pair);
  }

  /**
   * Create an unverified PlayerParent account inside the caller's transaction.
   * Returns the plaintext token so the email is sent only after it commits.
   */
  async createUnverifiedPlayer(
    input: {
      email: string;
      passwordHash: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
    manager: EntityManager,
  ): Promise<{ user: User; verificationToken: string }> {
    return this.createUnverifiedAccount({ ...input, role: Role.PlayerParent }, manager);
  }

  /**
   * As above, for any role. Takes a hash, not a password: every caller runs this
   * inside a transaction, and argon2id's ~40ms must not hold a pooled connection.
   */
  async createUnverifiedAccount(
    input: {
      email: string;
      passwordHash: string;
      role: Role;
      firstName?: string;
      lastName?: string;
      phone?: string;
    },
    manager: EntityManager,
  ): Promise<{ user: User; verificationToken: string }> {
    const user = await this.usersService.create(
      {
        email: input.email,
        role: input.role,
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        emailVerified: false,
        mustSetPassword: false,
        status: UserStatus.Active,
      },
      manager,
    );

    const verificationToken = await this.singleUseTokens.issue(
      manager.getRepository(EmailVerificationToken),
      user.id,
      EMAIL_VERIFICATION_TTL_MS,
    );

    return { user, verificationToken };
  }

  async createSetupToken(userId: string, manager?: EntityManager): Promise<string> {
    const repository =
      manager !== undefined ? manager.getRepository(AccountSetupToken) : this.accountSetups;
    return this.singleUseTokens.issue(repository, userId, ACCOUNT_SETUP_TTL_MS);
  }

  async setupPassword(
    input: { token: string; newPassword: string },
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const row = await this.singleUseTokens.validate(this.accountSetups, input.token, {
      invalid: 'Invalid setup token.',
      alreadyUsed: 'This setup token has already been used.',
      expired: 'This setup token has expired.',
    });

    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: 'Invalid setup token.',
      });
    }
    this.assertAccountUsable(user);

    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.clock.now();
    await this.singleUseTokens.markConsumed(this.accountSetups, row.id, now);
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
    return this.toAuthTokens(pair);
  }
}
