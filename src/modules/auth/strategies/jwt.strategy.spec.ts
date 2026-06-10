import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { ClockService } from '../../../shared/clock/clock.service';
import { Role } from '../../users/entities/user.enums';
import { AccessClaims } from '../auth.types';
import { Principal } from '../principal';
import { TokenService } from '../token.service';
import { JwtStrategy } from './jwt.strategy';

const config = new ConfigService({
  JWT_ACCESS_SECRET: 'access-secret-access-secret-access',
  JWT_REFRESH_SECRET: 'refresh-secret-refresh-secret-refresh',
});

describe('JwtStrategy (stateless mapping, no DB read)', () => {
  const tokenService = new TokenService(new JwtService({}), config, new ClockService());
  const strategy = new JwtStrategy(config);

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

  it('maps verified claims to a Principal for a trainer-scope user', () => {
    const claims = claimsFor({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      tokenVersion: 0,
    });

    const principal: Principal = strategy.validate(claims);

    expect(principal).toEqual({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 'session-1',
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: 0,
      scope: 'trainer',
      impersonating: false,
    });
  });

  it('maps a SuperAdmin to scope=platform', () => {
    const claims = claimsFor({
      userId: 'admin-1',
      role: Role.SuperAdmin,
      sessionId: 'session-2',
      tokenVersion: 5,
    });

    const principal: Principal = strategy.validate(claims);

    expect(principal.scope).toBe('platform');
    expect(principal.tokenVersion).toBe(5);
    expect(principal.impersonating).toBe(false);
  });

  it('sets actor and impersonating=true when the act claim is present', () => {
    const claims = claimsFor({
      userId: 'u-2',
      role: Role.PlayerParent,
      sessionId: 'session-3',
      tokenVersion: 0,
      actorUserId: 'admin-9',
    });

    const principal: Principal = strategy.validate(claims);

    expect(principal.impersonating).toBe(true);
    expect(principal.actor).toEqual({ userId: 'admin-9' });
  });
});
