import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { ClockService } from '../../../shared/clock/clock.service';
import { User } from '../../users/entities/user.entity';
import { Role, UserStatus } from '../../users/entities/user.enums';
import { AccessClaims } from '../auth.types';
import { AuthSession } from '../entities/auth-session.entity';
import { Principal } from '../principal';
import { SessionValidatorService, ValidatedSession } from '../session-validator.service';
import { TokenService } from '../token.service';
import { JwtStrategy } from './jwt.strategy';

const config = new ConfigService({
  JWT_ACCESS_SECRET: 'access-secret-access-secret-access',
  JWT_REFRESH_SECRET: 'refresh-secret-refresh-secret-refresh',
});

/**
 * The strategy delegates all revocation checks to SessionValidatorService (unit
 * tested separately); these tests pin the mapping from authoritative rows onto
 * the Principal.
 */
function validatorReturning(validated: ValidatedSession): SessionValidatorService {
  return { validate: jest.fn().mockResolvedValue(validated) } as unknown as SessionValidatorService;
}

function rows(
  over: {
    session?: Partial<AuthSession>;
    user?: Partial<User>;
    trainerOrgId?: string | null;
    coachProfileId?: string | null;
  } = {},
): ValidatedSession {
  return {
    trainerOrgId: over.trainerOrgId ?? null,
    coachProfileId: over.coachProfileId ?? null,
    session: {
      id: 'session-1',
      userId: 'u-1',
      activeTrainerProfileId: null,
      impersonatedBy: null,
      expiresAt: null,
      revokedAt: null,
      ...over.session,
    } as AuthSession,
    user: {
      id: 'u-1',
      role: Role.PlayerParent,
      status: UserStatus.Active,
      tokenVersion: 0,
      deletedAt: null,
      ...over.user,
    } as User,
  };
}

describe('JwtStrategy', () => {
  const tokenService = new TokenService(new JwtService({}), config, new ClockService());

  function claimsFor(input: {
    userId: string;
    role: Role;
    sessionId: string;
    tokenVersion: number;
    activeTrainerProfileId?: string | null;
    trainerOrgId?: string | null;
    actorUserId?: string;
  }): AccessClaims {
    const token = tokenService.signAccess({
      userId: input.userId,
      role: input.role,
      sessionId: input.sessionId,
      activeTrainerProfileId: input.activeTrainerProfileId ?? null,
      trainerOrgId: input.trainerOrgId ?? null,
      tokenVersion: input.tokenVersion,
      actorUserId: input.actorUserId,
    });
    return tokenService.verifyAccess(token);
  }

  it('maps validated rows to a Principal for a trainer-scope user', async () => {
    const strategy = new JwtStrategy(config, validatorReturning(rows()));
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      tokenVersion: 0,
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal).toEqual({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      activeTrainerProfileId: null,
      trainerOrgId: null,
      coachProfileId: null,
      tokenVersion: 0,
      scope: 'trainer',
      impersonating: false,
    });
  });

  it('carries the tenancy the validator resolved, not what the token claimed', async () => {
    const strategy = new JwtStrategy(
      config,
      validatorReturning(
        rows({
          user: { role: Role.Coach },
          trainerOrgId: 'org-1',
          coachProfileId: 'coach-profile-1',
        }),
      ),
    );
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.Coach,
      sessionId: 'session-1',
      tokenVersion: 0,
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal.trainerOrgId).toBe('org-1');
    expect(principal.coachProfileId).toBe('coach-profile-1');
  });

  it('maps a SuperAdmin to scope=platform', async () => {
    const strategy = new JwtStrategy(
      config,
      validatorReturning(rows({ user: { role: Role.SuperAdmin, tokenVersion: 5 } })),
    );
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.SuperAdmin,
      sessionId: 'session-1',
      tokenVersion: 5,
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal.scope).toBe('platform');
    expect(principal.tokenVersion).toBe(5);
    expect(principal.impersonating).toBe(false);
  });

  it('derives impersonation from the session row, not the act claim', async () => {
    const strategy = new JwtStrategy(
      config,
      validatorReturning(rows({ session: { impersonatedBy: 'admin-9' } })),
    );
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      tokenVersion: 0,
      actorUserId: 'admin-9',
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal.impersonating).toBe(true);
    expect(principal.actor).toEqual({ userId: 'admin-9' });
  });

  it('ignores a forged act claim when the session is not an impersonation', async () => {
    const strategy = new JwtStrategy(config, validatorReturning(rows()));
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      tokenVersion: 0,
      actorUserId: 'admin-9',
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal.impersonating).toBe(false);
    expect(principal.actor).toBeUndefined();
  });

  it('takes role and tenant context from the rows, not the stale claim', async () => {
    const strategy = new JwtStrategy(
      config,
      validatorReturning(
        rows({
          session: { activeTrainerProfileId: 'trainer-profile-7' },
          user: { role: Role.Trainer },
          trainerOrgId: 'trainer-profile-7',
        }),
      ),
    );
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      tokenVersion: 0,
    });

    const principal: Principal = await strategy.validate(claims);

    expect(principal.role).toBe(Role.Trainer);
    expect(principal.activeTrainerProfileId).toBe('trainer-profile-7');
    expect(principal.trainerOrgId).toBe('trainer-profile-7');
  });
});
