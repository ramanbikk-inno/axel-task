import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ImpersonationLog } from './entities/impersonation-log.entity';

/**
 * Writes to the impersonation audit trail (US-01.07).
 *
 * Deliberately split out of ImpersonationService and given its own module: an
 * impersonation session can end from paths that live in AuthModule — logout,
 * and the bulk revocation behind deactivation, GDPR deletion and password
 * change — and AuthModule cannot import ImpersonationModule, which already
 * imports it. This provider depends on nothing but its own table, so both
 * sides can use it without a cycle.
 *
 * Closing the log from every one of those paths is the point: until it was,
 * only an explicit `/exit` recorded an end time, so every other way of ending a
 * session left the row open forever and US-01.07's "start time, end time,
 * duration" was simply never reported for it.
 */
@Injectable()
export class ImpersonationLogService {
  constructor(
    @InjectRepository(ImpersonationLog)
    private readonly logs: Repository<ImpersonationLog>,
  ) {}

  private static durationSeconds(startedAt: Date, endedAt: Date): number {
    // Clamped: a clock that moved backwards must not write a negative duration
    // into a compliance report.
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
   * Close every open log for sessions belonging to a user.
   *
   * `revokeAllUserSessions` ends sessions in bulk without knowing which of them
   * were impersonations, so this mirrors it: the impersonated user is the
   * session's `user_id`, and therefore the target of the log.
   */
  async closeForTargetUser(targetUserId: string, endedAt: Date): Promise<void> {
    const open = await this.logs.find({ where: { targetUserId, endedAt: IsNull() } });
    if (open.length === 0) {
      return;
    }
    // One statement per distinct duration would be a query per row; instead
    // group the ids that share a computed duration.
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
   * Backfill end times for sessions that ended without anything closing the log
   * — most importantly the one-hour cap from US-01.07, which is enforced lazily
   * on the next request and so never fires an event of its own.
   *
   * The session row is the authority on when the session stopped being usable:
   * `revoked_at` if something revoked it, otherwise `expires_at` once it is in
   * the past. Called before reading the history so the report is correct even
   * for sessions that simply timed out and were never touched again.
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
