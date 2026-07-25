import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { Role } from '../users/entities/user.enums';
import { AccessClaims, RefreshClaims } from './auth.types';
import { TokenService } from './token.service';

class FakeClock {
  private current: Date = new Date('2026-01-01T00:00:00.000Z');
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const ACCESS_SECRET = 'access-secret-test-value-32chars-min!!';
const REFRESH_SECRET = 'refresh-secret-test-value-32chars-min!';
const ISSUER = 'axel-api-test';
const AUDIENCE = 'axel-app-test';

function buildConfig(): ConfigService {
  const map: Record<string, string> = {
    JWT_ACCESS_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
  };
  return {
    // Honours the default argument, as the real ConfigService does. Without
    // that the TTL/issuer lookups here silently resolve to undefined and this
    // stub stops standing for the thing it is standing in for.
    get: <T = string>(key: string, fallback?: T): T =>
      key in map ? (map[key] as unknown as T) : (fallback as T),
  } as unknown as ConfigService;
}

function buildService(clock: FakeClock): TokenService {
  return new TokenService(new JwtService({}), buildConfig(), clock as never);
}

describe('TokenService', () => {
  it('signAccess embeds claims and derives scope=trainer for non-SuperAdmin', () => {
    const service: TokenService = buildService(new FakeClock());
    const token: string = service.signAccess({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 's-1',
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: 0,
    });
    const claims: AccessClaims = service.verifyAccess(token);

    expect(claims.sub).toBe('u-1');
    expect(claims.role).toBe(Role.PlayerParent);
    expect(claims.sessionId).toBe('s-1');
    expect(claims.tenant.scope).toBe('trainer');
    expect(claims.tenant.activeTrainerProfileId).toBeNull();
    expect(claims.tenant.trainerOrgId).toBeNull();
    expect(claims.tokenVersion).toBe(0);
  });

  it('signAccess derives scope=platform for SuperAdmin', () => {
    const service: TokenService = buildService(new FakeClock());
    const token: string = service.signAccess({
      userId: 'admin-1',
      role: Role.SuperAdmin,
      sessionId: 's-2',
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: 3,
    });
    const claims: AccessClaims = service.verifyAccess(token);

    expect(claims.tenant.scope).toBe('platform');
    expect(claims.tokenVersion).toBe(3);
  });

  it('signRefresh returns {token, jti, familyId, expiresAt} with expiresAt = clock.now()+7d', () => {
    const clock = new FakeClock();
    clock.set(new Date('2026-03-01T00:00:00.000Z'));
    const service: TokenService = buildService(clock);

    const result = service.signRefresh({ userId: 'u-1', sessionId: 's-1' });

    expect(typeof result.token).toBe('string');
    expect(result.jti).toMatch(/[0-9a-f-]{36}/);
    expect(result.familyId).toMatch(/[0-9a-f-]{36}/);
    expect(result.expiresAt.toISOString()).toBe('2026-03-08T00:00:00.000Z');

    const claims: RefreshClaims = service.verifyRefresh(result.token);
    expect(claims.sub).toBe('u-1');
    expect(claims.sessionId).toBe('s-1');
    expect(claims.jti).toBe(result.jti);
    expect(claims.familyId).toBe(result.familyId);
  });

  it('signRefresh reuses a provided familyId', () => {
    const service: TokenService = buildService(new FakeClock());
    const result = service.signRefresh({
      userId: 'u-1',
      sessionId: 's-1',
      familyId: 'fam-fixed',
    });
    expect(result.familyId).toBe('fam-fixed');
  });

  it('a refresh token fails verifyAccess (separate secrets)', () => {
    const service: TokenService = buildService(new FakeClock());
    const refresh = service.signRefresh({ userId: 'u-1', sessionId: 's-1' });
    expect(() => service.verifyAccess(refresh.token)).toThrow();
  });

  it('a tampered access token throws on verify', () => {
    const service: TokenService = buildService(new FakeClock());
    const token: string = service.signAccess({
      userId: 'u-1',
      role: Role.PlayerParent,
      sessionId: 's-1',
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: 0,
    });
    const tampered: string = `${token}x`;
    expect(() => service.verifyAccess(tampered)).toThrow();
  });

  it('an expired access JWT (expiresIn 1ms) throws on verify', async () => {
    const service: TokenService = buildService(new FakeClock());
    const jwt = new JwtService({});
    // Signed with the real issuer/audience so this fails on expiry alone; a
    // bare payload would now be rejected before the clock was even consulted.
    const expired: string = jwt.sign(
      { sub: 'u-1' },
      { secret: ACCESS_SECRET, expiresIn: '1ms', issuer: ISSUER, audience: AUDIENCE },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(() => service.verifyAccess(expired)).toThrow();
  });

  it('access tokens carry iss, aud and a unique jti', () => {
    const service: TokenService = buildService(new FakeClock());
    const sign = (): AccessClaims =>
      service.verifyAccess(
        service.signAccess({
          userId: 'u-1',
          role: Role.PlayerParent,
          sessionId: 's-1',
          activeTrainerProfileId: null,
          trainerOrgId: null,
          tokenVersion: 0,
        }),
      );

    const first = sign();
    expect(first.iss).toBe(ISSUER);
    expect(first.aud).toBe(AUDIENCE);
    expect(first.jti).toMatch(/[0-9a-f-]{36}/);

    // Two tokens minted in the same second used to be byte-identical.
    expect(sign().jti).not.toBe(first.jti);
  });

  it.each([
    ['issuer', { issuer: 'someone-else', audience: AUDIENCE }],
    ['audience', { issuer: ISSUER, audience: 'someone-else' }],
  ])('rejects an access token with the wrong %s even under the right secret', (_label, opts) => {
    const service: TokenService = buildService(new FakeClock());
    const foreign: string = new JwtService({}).sign(
      { sub: 'u-1', tokenVersion: 0 },
      { secret: ACCESS_SECRET, expiresIn: '15m', ...opts },
    );
    expect(() => service.verifyAccess(foreign)).toThrow();
  });

  it('caps a refresh token at notAfter when that is sooner than the configured TTL', () => {
    const clock = new FakeClock();
    clock.set(new Date('2026-03-01T00:00:00.000Z'));
    const service: TokenService = buildService(clock);

    // The impersonation case: a one-hour session must not hold a seven-day
    // credential whose own `exp` disagrees with the session row.
    const cap = new Date('2026-03-01T01:00:00.000Z');
    const capped = service.signRefresh({ userId: 'u-1', sessionId: 's-1', notAfter: cap });

    expect(capped.expiresAt.toISOString()).toBe(cap.toISOString());

    // Assert the JWT's *lifetime*, not its absolute exp: jsonwebtoken stamps
    // iat from the real wall clock while the row is stamped from the injected
    // one, so only the delta is comparable under a fake clock.
    const claims = service.verifyRefresh(capped.token) as RefreshClaims & {
      exp: number;
      iat: number;
    };
    expect(claims.exp - claims.iat).toBe(3600);

    const uncapped = service.signRefresh({ userId: 'u-1', sessionId: 's-1' });
    const plain = service.verifyRefresh(uncapped.token) as RefreshClaims & {
      exp: number;
      iat: number;
    };
    expect(plain.exp - plain.iat).toBe(7 * 24 * 3600);
  });

  it('ignores a notAfter that is later than the configured TTL', () => {
    const clock = new FakeClock();
    clock.set(new Date('2026-03-01T00:00:00.000Z'));
    const service: TokenService = buildService(clock);

    const result = service.signRefresh({
      userId: 'u-1',
      sessionId: 's-1',
      notAfter: new Date('2027-01-01T00:00:00.000Z'),
    });

    expect(result.expiresAt.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('generateOpaqueToken/hashOpaqueToken are stable and consistent', () => {
    const service: TokenService = buildService(new FakeClock());
    const { token, tokenHash } = service.generateOpaqueToken();

    expect(token.length).toBeGreaterThan(0);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hashOpaqueToken(token)).toBe(tokenHash);
  });
});
