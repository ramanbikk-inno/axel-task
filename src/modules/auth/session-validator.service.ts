import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile, CoachStatus } from '../coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { User } from '../users/entities/user.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { AccessClaims } from './auth.types';
import { AuthSession } from './entities/auth-session.entity';

export interface ValidatedSession {
  session: AuthSession;
  user: User;
  /**
   * The trainer organisation this principal belongs to: their own org for a
   * Trainer, their employer's for a Coach, null for everyone else. This is the
   * key every org-scoped authorization rule compares against.
   */
  trainerOrgId: string | null;
  /** The Coach's own profile row id, or null for every other role. */
  coachProfileId: string | null;
  /**
   * Child-account identity (US-01.06), resolved from
   * `player_profiles.child_user_id`. Read per request rather than carried in
   * the token so unlinking a child login takes effect at once.
   */
  isChild: boolean;
  childPlayerProfileId: string | null;
  parentUserId: string | null;
}

const NOT_A_CHILD = {
  isChild: false as const,
  childPlayerProfileId: null,
  parentUserId: null,
};

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
    @InjectRepository(TrainerProfile)
    private readonly trainerProfiles: Repository<TrainerProfile>,
    @InjectRepository(CoachProfile)
    private readonly coachProfiles: Repository<CoachProfile>,
    @InjectRepository(PlayerProfile)
    private readonly playerProfiles: Repository<PlayerProfile>,
    private readonly clock: ClockService,
  ) {}

  /**
   * Resolved per request rather than baked into the token: it is the tenancy
   * key, so it must reflect the database now, not whenever the token happened
   * to be minted. Only Trainers and Coaches pay for the extra indexed lookup.
   *
   * A Coach's tenancy comes from their employer, so their org-scoped rules key
   * on `coach_profiles.trainer_profile_id`; leaving it null would silently
   * scope every Coach rule to nothing.
   */
  private async resolveTenancy(
    user: User,
  ): Promise<
    Pick<
      ValidatedSession,
      'trainerOrgId' | 'coachProfileId' | 'isChild' | 'childPlayerProfileId' | 'parentUserId'
    >
  > {
    if (user.role === Role.Trainer) {
      const profile = await this.trainerProfiles.findOne({
        where: { userId: user.id },
        select: { id: true },
      });
      return { trainerOrgId: profile?.id ?? null, coachProfileId: null, ...NOT_A_CHILD };
    }
    if (user.role === Role.Coach) {
      // Active only. An off-boarded coach keeps their row so the engagement
      // stays in the record, but they must stop inheriting their former
      // employer's tenancy the moment it ends — otherwise every org-scoped
      // rule still resolves for them.
      const profile = await this.coachProfiles.findOne({
        where: { userId: user.id, status: CoachStatus.Active },
        select: { id: true, trainerProfileId: true },
      });
      return {
        trainerOrgId: profile?.trainerProfileId ?? null,
        coachProfileId: profile?.id ?? null,
        ...NOT_A_CHILD,
      };
    }

    // A PlayerParent login attached to a child profile is a *child* account.
    // One indexed lookup on a unique column, only for this role.
    const asChild = await this.playerProfiles.findOne({
      where: { childUserId: user.id },
      select: { id: true, ownerUserId: true },
    });
    if (asChild) {
      return {
        trainerOrgId: null,
        coachProfileId: null,
        isChild: true,
        childPlayerProfileId: asChild.id,
        parentUserId: asChild.ownerUserId,
      };
    }

    return { trainerOrgId: null, coachProfileId: null, ...NOT_A_CHILD };
  }

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

    return { session, user, ...(await this.resolveTenancy(user)) };
  }
}
