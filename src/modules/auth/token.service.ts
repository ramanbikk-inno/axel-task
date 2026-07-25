import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';

import { ClockService } from '../../shared/clock/clock.service';
import { Role } from '../users/entities/user.enums';
import { AccessClaims, RefreshClaims } from './auth.types';
import { scopeForRole } from './principal';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly clock: ClockService,
  ) {}

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
      expiresIn: ACCESS_TTL,
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
    const payload: RefreshClaims = {
      sub: input.userId,
      sessionId: input.sessionId,
      jti,
      familyId,
    };
    const token: string = this.jwt.sign(payload, {
      secret: this.refreshSecret(),
      expiresIn: REFRESH_TTL,
    });
    const expiresAt: Date = new Date(this.clock.now().getTime() + REFRESH_TTL_MS);
    return { token, jti, familyId, expiresAt };
  }

  verifyAccess(token: string): AccessClaims {
    return this.jwt.verify<AccessClaims>(token, {
      secret: this.accessSecret(),
    });
  }

  verifyRefresh(token: string): RefreshClaims {
    return this.jwt.verify<RefreshClaims>(token, {
      secret: this.refreshSecret(),
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
