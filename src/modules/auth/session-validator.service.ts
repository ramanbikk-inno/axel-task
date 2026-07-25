import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/entities/user.enums';
import { AccessClaims } from './auth.types';
import { AuthSession } from './entities/auth-session.entity';

export interface ValidatedSession {
  session: AuthSession;
  user: User;
}

function reject(errorCode: ErrorCode, message: string): UnauthorizedException {
  return new UnauthorizedException({ errorCode, message });
}

/**
 * Re-validates an already signature-verified access token against authoritative
 * server state.
 *
 * Access tokens carry a 15-minute TTL, so a purely stateless check would leave
 * every revocation path in the system — logout, Super Admin deactivation, GDPR
 * deletion, password reset and impersonation exit — inert for up to 15 minutes
 * after the fact. The system already records all of that state
 * (`auth_session.revoked_at`, `auth_session.expires_at`, `users.status`,
 * `users.token_version`); nothing on the access path read it.
 *
 * Cost is two indexed primary-key lookups per authenticated request.
 */
@Injectable()
export class SessionValidatorService {
  constructor(
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly clock: ClockService,
  ) {}

  async validate(claims: AccessClaims): Promise<ValidatedSession> {
    const session: AuthSession | null = await this.sessions.findOne({
      where: { id: claims.sessionId },
    });
    if (!session) {
      throw reject(ErrorCode.INVALID_TOKEN, 'Session no longer exists.');
    }

    // A token must be presented against the session it was minted for; this
    // also stops a valid token for user A being replayed against B's session.
    if (session.userId !== claims.sub) {
      throw reject(ErrorCode.INVALID_TOKEN, 'Token does not match its session.');
    }

    if (session.revokedAt !== null) {
      throw reject(ErrorCode.SESSION_REVOKED, 'Session has been revoked.');
    }

    // Impersonation sessions are the only ones with a hard expiry today; this is
    // what actually enforces the one-hour cap from US-01.07.
    if (session.expiresAt !== null && session.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw reject(ErrorCode.SESSION_EXPIRED, 'Session has expired.');
    }

    // withDeleted so a GDPR-anonymised (soft-deleted) account is rejected
    // explicitly rather than looking like an unknown user.
    const user: User | null = await this.users.findOne({
      where: { id: claims.sub },
      withDeleted: true,
    });
    if (!user) {
      throw reject(ErrorCode.INVALID_TOKEN, 'Account no longer exists.');
    }
    if (user.deletedAt !== null || user.status === UserStatus.Deleted) {
      throw reject(ErrorCode.ACCOUNT_DELETED, 'This account has been deleted.');
    }
    if (user.status !== UserStatus.Active) {
      throw reject(ErrorCode.ACCOUNT_INACTIVE, 'Account deactivated. Contact support.');
    }

    // Bumped whenever credentials change; invalidates every token minted before.
    if (user.tokenVersion !== claims.tokenVersion) {
      throw reject(ErrorCode.CREDENTIALS_CHANGED, 'Credentials changed. Sign in again.');
    }

    return { session, user };
  }
}
