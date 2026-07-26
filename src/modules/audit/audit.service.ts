import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { Principal } from '../auth/principal';
import { AuditLog } from './entities/audit-log.entity';

/** What an audited action was done *to*, when that is not a user. */
export interface AuditTarget {
  type: string;
  id: string;
}

export interface RecordAuditInput {
  action: string;
  /**
   * The principal that performed the action.
   *
   * Deliberately the whole principal rather than a user id. US-01.07 requires
   * that actions taken during an impersonation are attributable to the admin
   * behind them, and a bare `actorUserId: string` gave every call site the
   * chance to forget that — silently, since the row still looked complete.
   * Passing the principal makes attribution structural: there is no way to
   * record an action from inside an impersonation session and lose the admin.
   *
   * Use `recordSystemAction` for something with no user behind it, so "no
   * actor" is always a decision rather than an omission.
   */
  actor: Principal;
  targetUserId?: string | null;
  target?: AuditTarget | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
    private readonly clock: ClockService,
  ) {}

  async record(input: RecordAuditInput, manager?: EntityManager): Promise<AuditLog> {
    const actor = input.actor;
    // actorUserId stays the identity the request was made *as* — for an
    // impersonation that is the target, which is the truth about what the
    // system saw. The admin behind it goes in its own column, so both
    // questions can be answered from one row without reinterpreting either.
    const impersonating = actor.impersonating && actor.actor !== undefined;

    return this.write(
      {
        action: input.action,
        actorUserId: actor.userId,
        onBehalfOfAdminId: impersonating ? (actor.actor as { userId: string }).userId : null,
        impersonationSessionId: impersonating ? actor.sessionId : null,
        targetUserId: input.targetUserId ?? null,
        targetType: input.target?.type ?? null,
        targetId: input.target?.id ?? null,
        metadata: input.metadata ?? null,
      },
      manager,
    );
  }

  /** Something the system did with no user behind it (a job, a seed). */
  async recordSystemAction(
    input: Omit<RecordAuditInput, 'actor'>,
    manager?: EntityManager,
  ): Promise<AuditLog> {
    return this.write(
      {
        action: input.action,
        actorUserId: null,
        onBehalfOfAdminId: null,
        impersonationSessionId: null,
        targetUserId: input.targetUserId ?? null,
        targetType: input.target?.type ?? null,
        targetId: input.target?.id ?? null,
        metadata: input.metadata ?? null,
      },
      manager,
    );
  }

  private async write(
    row: Omit<AuditLog, 'id' | 'createdAt'>,
    manager?: EntityManager,
  ): Promise<AuditLog> {
    const repository: Repository<AuditLog> =
      manager !== undefined ? manager.getRepository(AuditLog) : this.auditRepository;
    return repository.save(repository.create({ ...row, createdAt: this.clock.now() }));
  }

  /**
   * Redact a person's email address out of retained audit metadata (US-01.13).
   *
   * The trail itself must survive an erasure — it is the compliance record —
   * but the coach-invitation actions copy the recipient's address into
   * `metadata.email`, so anonymising `users` alone left the address readable in
   * every impersonation-history and audit view. Only that one key is touched:
   * the action, actor, target and timestamps are exactly what the log exists to
   * preserve, and rewriting the whole document would destroy them.
   *
   * `->>` compares the extracted text, so rows whose metadata has no `email`
   * key are simply not matched.
   */
  async scrubEmailFromMetadata(email: string, manager?: EntityManager): Promise<void> {
    const repository: Repository<AuditLog> =
      manager !== undefined ? manager.getRepository(AuditLog) : this.auditRepository;
    await repository
      .createQueryBuilder()
      .update(AuditLog)
      .set({ metadata: () => `jsonb_set("metadata", '{email}', '"[redacted]"')` })
      .where(`LOWER("metadata" ->> 'email') = LOWER(:email)`, { email })
      .execute();
  }

  async findByTarget(targetUserId: string): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { targetUserId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Everything recorded during a set of impersonation sessions, oldest first. */
  async findByImpersonationSessions(sessionIds: string[]): Promise<Map<string, AuditLog[]>> {
    const bySession = new Map<string, AuditLog[]>();
    if (sessionIds.length === 0) {
      return bySession;
    }
    const rows = await this.auditRepository.find({
      where: sessionIds.map((id) => ({ impersonationSessionId: id })),
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    for (const row of rows) {
      const key = row.impersonationSessionId as string;
      bySession.set(key, [...(bySession.get(key) ?? []), row]);
    }
    return bySession;
  }
}
