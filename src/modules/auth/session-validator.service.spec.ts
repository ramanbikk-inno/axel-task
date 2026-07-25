import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { CoachProfile } from '../coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { User } from '../users/entities/user.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { AccessClaims } from './auth.types';
import { AuthSession } from './entities/auth-session.entity';
import { SessionValidatorService } from './session-validator.service';

const NOW = new Date('2026-01-01T12:00:00.000Z');

class FixedClock extends ClockService {
  now(): Date {
    return NOW;
  }
}

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-1',
    userId: 'user-1',
    activeTrainerProfileId: null,
    impersonatedBy: null,
    expiresAt: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    userAgent: null,
    ip: null,
    revokedAt: null,
    revokedReason: null,
    ...over,
  } as AuthSession;
}

function user(over: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'player@example.com',
    role: Role.PlayerParent,
    status: UserStatus.Active,
    emailVerified: true,
    tokenVersion: 0,
    deletedAt: null,
    ...over,
  } as User;
}

function claims(over: Partial<AccessClaims> = {}): AccessClaims {
  return {
    sub: 'user-1',
    role: Role.PlayerParent,
    sessionId: 'session-1',
    tenant: { activeTrainerProfileId: null, trainerOrgId: null, scope: 'trainer' },
    tokenVersion: 0,
    ...over,
  };
}

function build(
  sessionRow: AuthSession | null,
  userRow: User | null,
  trainerProfileRow: { id: string } | null = null,
  coachProfileRow: { id: string; trainerProfileId: string } | null = null,
  playerProfileRow: { id: string; ownerUserId: string } | null = null,
): SessionValidatorService {
  const sessions = {
    findOne: jest.fn().mockResolvedValue(sessionRow),
  } as unknown as Repository<AuthSession>;
  const users = { findOne: jest.fn().mockResolvedValue(userRow) } as unknown as Repository<User>;
  const trainerProfiles = {
    findOne: jest.fn().mockResolvedValue(trainerProfileRow),
  } as unknown as Repository<TrainerProfile>;
  const coachProfiles = {
    findOne: jest.fn().mockResolvedValue(coachProfileRow),
  } as unknown as Repository<CoachProfile>;
  const playerProfiles = {
    findOne: jest.fn().mockResolvedValue(playerProfileRow ?? null),
  } as unknown as Repository<PlayerProfile>;
  return new SessionValidatorService(
    sessions,
    users,
    trainerProfiles,
    coachProfiles,
    playerProfiles,
    new FixedClock(),
  );
}

async function expectRejection(
  service: SessionValidatorService,
  input: AccessClaims,
  errorCode: ErrorCode,
): Promise<void> {
  await expect(service.validate(input)).rejects.toBeInstanceOf(UnauthorizedException);
  await service.validate(input).catch((error: UnauthorizedException) => {
    expect((error.getResponse() as { errorCode: ErrorCode }).errorCode).toBe(errorCode);
  });
}

describe('SessionValidatorService', () => {
  it('accepts a live session for an active user', async () => {
    const service = build(session(), user());

    const result = await service.validate(claims());

    expect(result.session.id).toBe('session-1');
    expect(result.user.id).toBe('user-1');
  });

  it('rejects a token whose session row no longer exists', async () => {
    await expectRejection(build(null, user()), claims(), ErrorCode.INVALID_TOKEN);
  });

  it('rejects a token replayed against another user’s session', async () => {
    const service = build(session({ userId: 'someone-else' }), user());

    await expectRejection(service, claims(), ErrorCode.INVALID_TOKEN);
  });

  it('rejects a revoked session (logout, deactivation, impersonation exit)', async () => {
    const service = build(session({ revokedAt: NOW, revokedReason: 'logout' }), user());

    await expectRejection(service, claims(), ErrorCode.SESSION_REVOKED);
  });

  it('rejects a session past its hard expiry (impersonation 1h cap)', async () => {
    const expired = new Date(NOW.getTime() - 1000);
    const service = build(session({ expiresAt: expired, impersonatedBy: 'admin-1' }), user());

    await expectRejection(service, claims(), ErrorCode.SESSION_EXPIRED);
  });

  it('accepts an impersonation session that has not yet expired', async () => {
    const future = new Date(NOW.getTime() + 60_000);
    const service = build(session({ expiresAt: future, impersonatedBy: 'admin-1' }), user());

    const result = await service.validate(claims());

    expect(result.session.impersonatedBy).toBe('admin-1');
  });

  it('rejects a deactivated user', async () => {
    const service = build(session(), user({ status: UserStatus.Inactive }));

    await expectRejection(service, claims(), ErrorCode.ACCOUNT_INACTIVE);
  });

  it('rejects a GDPR-deleted user', async () => {
    const service = build(session(), user({ status: UserStatus.Deleted }));

    await expectRejection(service, claims(), ErrorCode.ACCOUNT_DELETED);
  });

  it('rejects a soft-deleted user even if status was left Active', async () => {
    const service = build(session(), user({ deletedAt: NOW }));

    await expectRejection(service, claims(), ErrorCode.ACCOUNT_DELETED);
  });

  it('resolves trainerOrgId from trainer_profiles for a Trainer', async () => {
    const service = build(session(), user({ role: Role.Trainer }), { id: 'trainer-profile-7' });

    const result = await service.validate(claims());

    // This was hardcoded null at every token-issue site, so every org-scoped
    // authorization rule compared against null and matched nothing.
    expect(result.trainerOrgId).toBe('trainer-profile-7');
  });

  it('leaves trainerOrgId null for a Trainer with no profile row yet', async () => {
    const service = build(session(), user({ role: Role.Trainer }), null);

    expect((await service.validate(claims())).trainerOrgId).toBeNull();
  });

  it.each([Role.PlayerParent, Role.SuperAdmin])(
    'leaves trainerOrgId null for %s',
    async (role: Role) => {
      const service = build(session(), user({ role }), { id: 'should-not-be-used' });

      const result = await service.validate(claims());

      expect(result.trainerOrgId).toBeNull();
      expect(result.coachProfileId).toBeNull();
    },
  );

  it("resolves a Coach's tenancy from their employer's coach_profiles row", async () => {
    const service = build(session(), user({ role: Role.Coach }), null, {
      id: 'coach-profile-3',
      trainerProfileId: 'trainer-profile-7',
    });

    const result = await service.validate(claims());

    // A Coach belongs to the org that employs them; without this their
    // org-scoped ability rules would all compare against null.
    expect(result.trainerOrgId).toBe('trainer-profile-7');
    expect(result.coachProfileId).toBe('coach-profile-3');
  });

  it('leaves a Coach with no profile row unscoped rather than guessing', async () => {
    const service = build(session(), user({ role: Role.Coach }), { id: 'should-not-be-used' });

    const result = await service.validate(claims());

    expect(result.trainerOrgId).toBeNull();
    expect(result.coachProfileId).toBeNull();
  });

  it('rejects a token minted before a credential change', async () => {
    const service = build(session(), user({ tokenVersion: 3 }));

    await expectRejection(service, claims({ tokenVersion: 2 }), ErrorCode.CREDENTIALS_CHANGED);
  });
});
