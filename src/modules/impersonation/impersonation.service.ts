import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { Action, AbilityFactory } from '../ability/ability.factory';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Principal } from '../auth/principal';
import { TokenService } from '../auth/token.service';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

/** Impersonation sessions are hard-capped at one hour (US-01.07). */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

export interface ImpersonationBanner {
  impersonatedUserId: string;
  name: string;
  role: string;
}

export interface StartImpersonationResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  sessionExpiresAt: string;
  banner: ImpersonationBanner;
}

function displayName(user: User): string {
  const full = [user.firstName, user.lastName].filter((v) => v && v.trim() !== '').join(' ');
  return full !== '' ? full : user.email;
}

@Injectable()
export class ImpersonationService {
  constructor(
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(ImpersonationLog) private readonly logs: Repository<ImpersonationLog>,
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
    private readonly usersService: UsersService,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  async start(
    principal: Principal,
    targetUserId: string,
    meta: { ip?: string; userAgent?: string },
    reason?: string,
  ): Promise<StartImpersonationResult> {
    if (principal.impersonating) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_IMPERSONATE,
        message: 'Exit the current impersonation session before starting another.',
      });
    }

    const target = await this.usersService.findById(targetUserId);
    if (!target) {
      throw new NotFoundException({ errorCode: ErrorCode.NOT_FOUND, message: 'User not found.' });
    }

    // Fine-grained rule check against the target's attributes: SuperAdmins and
    // self cannot be impersonated (encoded in AbilityFactory).
    const ability = this.abilityFactory.createForPrincipal(principal);
    const subject = { __type: 'User', id: target.id, role: target.role } as unknown as 'User';
    if (!ability.can(Action.Impersonate, subject)) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_IMPERSONATE,
        message: 'This user cannot be impersonated.',
      });
    }

    if (target.status !== UserStatus.Active) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_IMPERSONATE,
        message: 'Only active users can be impersonated.',
      });
    }

    const now = this.clock.now();
    const sessionExpiresAt = new Date(now.getTime() + IMPERSONATION_TTL_MS);

    const session = await this.sessions.save(
      this.sessions.create({
        userId: target.id,
        activeTrainerProfileId: null,
        impersonatedBy: principal.userId,
        expiresAt: sessionExpiresAt,
        createdAt: now,
        lastUsedAt: now,
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        revokedAt: null,
        revokedReason: null,
      }),
    );

    const accessToken = this.tokens.signAccess({
      userId: target.id,
      role: target.role,
      sessionId: session.id,
      activeTrainerProfileId: null,
      trainerOrgId: null,
      tokenVersion: target.tokenVersion,
      actorUserId: principal.userId,
    });

    // Capped to the session, not the ordinary seven days. `refresh()` already
    // refuses a token whose session has expired, but that is one runtime check
    // standing between a live seven-day credential and an account; the JWT's
    // own `exp` should say the same thing the session row does.
    const refresh = this.tokens.signRefresh({
      userId: target.id,
      sessionId: session.id,
      notAfter: sessionExpiresAt,
    });
    await this.refreshTokens.save(
      this.refreshTokens.create({
        id: refresh.jti,
        sessionId: session.id,
        userId: target.id,
        familyId: refresh.familyId,
        tokenHash: this.tokens.hashOpaqueToken(refresh.token),
        expiresAt: refresh.expiresAt,
        revokedAt: null,
        replacedById: null,
      }),
    );

    await this.logs.save(
      this.logs.create({
        adminUserId: principal.userId,
        targetUserId: target.id,
        sessionId: session.id,
        startedAt: now,
        endedAt: null,
        durationSeconds: null,
        reason: reason ?? null,
      }),
    );

    return {
      accessToken,
      refreshToken: refresh.token,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds(),
      sessionExpiresAt: sessionExpiresAt.toISOString(),
      banner: {
        impersonatedUserId: target.id,
        name: displayName(target),
        role: target.role,
      },
    };
  }

  async exit(principal: Principal): Promise<void> {
    if (!principal.impersonating || !principal.actor) {
      throw new ForbiddenException({
        errorCode: ErrorCode.NOT_IMPERSONATING,
        message: 'Not in an impersonation session.',
      });
    }

    const now = this.clock.now();
    const log = await this.logs.findOne({
      where: { sessionId: principal.sessionId, endedAt: IsNull() },
    });
    if (log) {
      const durationSeconds = Math.max(
        0,
        Math.round((now.getTime() - log.startedAt.getTime()) / 1000),
      );
      await this.logs.update({ id: log.id }, { endedAt: now, durationSeconds });
    }

    await this.sessions.update(
      { id: principal.sessionId },
      { revokedAt: now, revokedReason: 'impersonation-exit' },
    );
    await this.refreshTokens.update(
      { sessionId: principal.sessionId, revokedAt: IsNull() },
      { revokedAt: now },
    );
  }

  async banner(
    principal: Principal,
  ): Promise<{ impersonating: boolean; adminUserId?: string; target?: ImpersonationBanner }> {
    if (!principal.impersonating || !principal.actor) {
      return { impersonating: false };
    }
    const target = await this.usersService.findById(principal.userId);
    if (!target) {
      return { impersonating: false };
    }
    return {
      impersonating: true,
      adminUserId: principal.actor.userId,
      target: {
        impersonatedUserId: target.id,
        name: displayName(target),
        role: target.role,
      },
    };
  }
}
