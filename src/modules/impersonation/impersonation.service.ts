import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { displayNameFor } from '../../shared/format/display-name';
import { ErrorCode } from '../../shared/errors/error-codes';
import { Action, AbilityFactory } from '../ability/ability.factory';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { AuthTokens } from '../auth/auth.types';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Principal } from '../auth/principal';
import { TokenService } from '../auth/token.service';
import { UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { ImpersonationHistoryView } from './dto/impersonation-history.dto';
import { ImpersonationLogService } from './impersonation-log.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

/** Impersonation sessions are hard-capped at one hour. */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

export interface ImpersonationBanner {
  impersonatedUserId: string;
  name: string;
  role: string;
}

export interface StartImpersonationResult extends AuthTokens {
  sessionExpiresAt: string;
  banner: ImpersonationBanner;
}

@Injectable()
export class ImpersonationService {
  constructor(
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(ImpersonationLog) private readonly logs: Repository<ImpersonationLog>,
    private readonly authService: AuthService,
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
    private readonly usersService: UsersService,
    private readonly abilityFactory: AbilityFactory,
    private readonly audit: AuditService,
    private readonly impersonationLogs: ImpersonationLogService,
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

    // Same session/token issuance as an ordinary login, just capped to the
    // session and stamped with who is behind the wheel. Capping the refresh
    // token to the session, not the ordinary seven days, matters: `refresh()`
    // already refuses a token whose session has expired, but that is one
    // runtime check standing between a live seven-day credential and an
    // account; the JWT's own `exp` should say the same thing the session row
    // does.
    const issued = await this.authService.issueTokensForSession(target, meta, {
      impersonatedBy: principal.userId,
      actorUserId: principal.userId,
      expiresAt: sessionExpiresAt,
    });

    await this.logs.save(
      this.logs.create({
        adminUserId: principal.userId,
        targetUserId: target.id,
        sessionId: issued.sessionId,
        startedAt: now,
        endedAt: null,
        durationSeconds: null,
        reason: reason ?? null,
      }),
    );

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds(),
      sessionExpiresAt: sessionExpiresAt.toISOString(),
      banner: {
        impersonatedUserId: target.id,
        name: displayNameFor(target, target.email),
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
    await this.impersonationLogs.closeForSession(principal.sessionId, now);

    await this.sessions.update(
      { id: principal.sessionId },
      { revokedAt: now, revokedReason: 'impersonation-exit' },
    );
    await this.refreshTokens.update(
      { sessionId: principal.sessionId, revokedAt: IsNull() },
      { revokedAt: now },
    );
  }

  /**
   * Compliance report: who impersonated whom, when, for how long, why, and what
   * they did. Actions are matched on `audit_logs.impersonation_session_id` —
   * `actor_user_id` on those rows is the impersonated user, not the admin.
   */
  async history(query: {
    adminUserId?: string;
    targetUserId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ImpersonationHistoryView> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Record<string, string> = {};
    if (query.adminUserId !== undefined) {
      where.adminUserId = query.adminUserId;
    }
    if (query.targetUserId !== undefined) {
      where.targetUserId = query.targetUserId;
    }

    let [logs, total] = await this.logs.findAndCount({
      where,
      order: { startedAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Sessions that hit the one-hour cap end without anything running: the
    // expiry is enforced lazily on the next request, so there is no moment at
    // which a close could have been written. Reconcile those rows against the
    // session before reporting, then re-read the page — otherwise the report
    // shows a null end time and duration for a session that plainly finished.
    const openIds = logs.filter((l) => l.endedAt === null).map((l) => l.id);
    if (openIds.length > 0) {
      await this.impersonationLogs.reconcileOpenLogs(openIds, this.clock.now());
      [logs, total] = await this.logs.findAndCount({
        where,
        order: { startedAt: 'DESC', id: 'DESC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    }

    const actionsBySession = await this.audit.findByImpersonationSessions(
      logs.map((l) => l.sessionId),
    );
    // Emails are resolved in one lookup for the whole page rather than per row.
    const userIds = [...new Set(logs.flatMap((l) => [l.adminUserId, l.targetUserId]))];
    const users = await this.usersService.findByIds(userIds);
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    return {
      items: logs.map((log) => ({
        sessionId: log.sessionId,
        adminUserId: log.adminUserId,
        adminEmail: emailById.get(log.adminUserId) ?? null,
        targetUserId: log.targetUserId,
        targetEmail: emailById.get(log.targetUserId) ?? null,
        startedAt: log.startedAt.toISOString(),
        endedAt: log.endedAt?.toISOString() ?? null,
        durationSeconds: log.durationSeconds,
        reason: log.reason,
        actions: (actionsBySession.get(log.sessionId) ?? []).map((row) => ({
          action: row.action,
          at: row.createdAt.toISOString(),
          metadata: row.metadata,
        })),
      })),
      total,
      page,
      pageSize,
    };
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
        name: displayNameFor(target, target.email),
        role: target.role,
      },
    };
  }
}
