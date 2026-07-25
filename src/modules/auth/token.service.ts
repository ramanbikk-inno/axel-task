import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';

import { ClockService } from '../../shared/clock/clock.service';
import { durationToSeconds } from '../../shared/config/duration';
import { Role } from '../users/entities/user.enums';
import { AccessClaims, RefreshClaims } from './auth.types';
import { scopeForRole } from './principal';

interface SignAccessInput {
  userId: string;
  role: Role;
  sessionId: string;
  activeTrainerProfileId: string | null;
  trainerOrgId: string | null;
  tokenVersion: number;
  actorUserId?: string;
}

interface SignRefreshInput {
  userId: string;
  sessionId: string;
  familyId?: string;
  /**
   * Hard ceiling on the token's lifetime. Impersonation passes its session's
   * one-hour cap here so the credential itself dies with the session instead of
   * lingering as a seven-day row that only a runtime check keeps unusable.
   */
  notAfter?: Date;
}

@Injectable()
export class TokenService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly clock: ClockService,
  ) {
    this.accessTtl = durationToSeconds(this.config.get<string>('JWT_ACCESS_TTL', '15m'));
    this.refreshTtl = durationToSeconds(this.config.get<string>('JWT_REFRESH_TTL', '7d'));
    this.issuer = this.config.get<string>('JWT_ISSUER', 'axel-api');
    this.audience = this.config.get<string>('JWT_AUDIENCE', 'axel-app');
  }

  /** The advertised `expiresIn`, derived from the configured TTL rather than restated. */
  accessTtlSeconds(): number {
    return this.accessTtl;
  }

  private accessSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET') as string;
  }

  private refreshSecret(): string {
    return this.config.get<string>('JWT_REFRESH_SECRET') as string;
  }

  signAccess(input: SignAccessInput): string {
    const payload: AccessClaims = {
      sub: input.userId,
      role: input.role,
      sessionId: input.sessionId,
      tenant: {
        activeTrainerProfileId: input.activeTrainerProfileId,
        trainerOrgId: input.trainerOrgId,
        scope: scopeForRole(input.role),
      },
      tokenVersion: input.tokenVersion,
    };
    if (input.actorUserId) {
      payload.act = { sub: input.actorUserId };
    }
    return this.jwt.sign(payload, {
      secret: this.accessSecret(),
      expiresIn: this.accessTtl,
      issuer: this.issuer,
      audience: this.audience,
      // A unique id per access token: without it two tokens minted in the same
      // second for the same session are byte-identical, which makes them
      // impossible to tell apart in a log or to revoke individually later.
      jwtid: uuidv4(),
    });
  }

  signRefresh(input: SignRefreshInput): {
    token: string;
    jti: string;
    familyId: string;
    expiresAt: Date;
  } {
    const jti: string = uuidv4();
    const familyId: string = input.familyId ?? uuidv4();
    const now = this.clock.now();

    const defaultExpiry = new Date(now.getTime() + this.refreshTtl * 1000);
    const expiresAt: Date =
      input.notAfter !== undefined && input.notAfter.getTime() < defaultExpiry.getTime()
        ? input.notAfter
        : defaultExpiry;
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

    const payload: RefreshClaims = {
      sub: input.userId,
      sessionId: input.sessionId,
      jti,
      familyId,
    };
    const token: string = this.jwt.sign(payload, {
      secret: this.refreshSecret(),
      expiresIn: ttlSeconds,
      issuer: this.issuer,
      audience: this.audience,
    });
    return { token, jti, familyId, expiresAt };
  }

  verifyAccess(token: string): AccessClaims {
    return this.jwt.verify<AccessClaims>(token, {
      secret: this.accessSecret(),
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  verifyRefresh(token: string): RefreshClaims {
    return this.jwt.verify<RefreshClaims>(token, {
      secret: this.refreshSecret(),
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  generateOpaqueToken(): { token: string; tokenHash: string } {
    const token: string = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashOpaqueToken(token) };
  }

  hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
