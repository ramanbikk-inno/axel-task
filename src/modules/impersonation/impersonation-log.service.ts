import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ImpersonationLog } from './entities/impersonation-log.entity';

/**
 * Writes to the impersonation audit trail.
 *
 * Split into its own module because sessions also end from AuthModule (logout,
 * bulk revocation) and AuthModule cannot import ImpersonationModule, which
 * already imports it. This depends on nothing but its own table.
 */
@Injectable()
export class ImpersonationLogService {
  constructor(
    @InjectRepository(ImpersonationLog)
    private readonly logs: Repository<ImpersonationLog>,
  ) {}

  private static durationSeconds(startedAt: Date, endedAt: Date): number {
    // Clamped so a backwards clock cannot write a negative duration.
    return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  }

  /** Close the open log for one session, if there is one. Idempotent. */
  async closeForSession(sessionId: string, endedAt: Date): Promise<void> {
    const log = await this.logs.findOne({ where: { sessionId, endedAt: IsNull() } });
    if (!log) {
      return;
    }
    await this.logs.update(
      { id: log.id },
      { endedAt, durationSeconds: ImpersonationLogService.durationSeconds(log.startedAt, endedAt) },
    );
  }

  /**
   * Close every open log for a user's sessions. Mirrors `revokeAllUserSessions`,
   * which ends sessions in bulk without knowing which were impersonations.
   */
  async closeForTargetUser(targetUserId: string, endedAt: Date): Promise<void> {
    const open = await this.logs.find({ where: { targetUserId, endedAt: IsNull() } });
    if (open.length === 0) {
      return;
    }
    for (const log of open) {
      await this.logs.update(
        { id: log.id },
        {
          endedAt,
          durationSeconds: ImpersonationLogService.durationSeconds(log.startedAt, endedAt),
        },
      );
    }
  }

  /**
   * Backfill end times for sessions that expired rather than being ended. The
   * one-hour cap is enforced lazily on the next request, so nothing fires when
   * it lapses; the session row is the authority on when it stopped being usable.
   */
  async reconcileOpenLogs(logIds: string[], now: Date): Promise<void> {
    if (logIds.length === 0) {
      return;
    }
    await this.logs.query(
      `UPDATE "impersonation_logs" AS l
          SET "ended_at" = e.ended_at,
              "duration_seconds" = GREATEST(
                0, ROUND(EXTRACT(EPOCH FROM (e.ended_at - l."started_at")))::int
              )
         FROM (
           SELECT s."id" AS session_id,
                  COALESCE(s."revoked_at", s."expires_at") AS ended_at
             FROM "auth_session" s
            WHERE s."revoked_at" IS NOT NULL
               OR (s."expires_at" IS NOT NULL AND s."expires_at" <= $2)
         ) AS e
        WHERE l."session_id" = e.session_id
          AND l."ended_at" IS NULL
          AND l."id" = ANY($1)`,
      [logIds, now],
    );
  }
}
