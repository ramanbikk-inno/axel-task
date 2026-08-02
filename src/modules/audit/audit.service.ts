import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { repoFor } from '../../shared/database/repo-for';
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
   * The whole principal, not a user id: it carries the admin behind an
   * impersonation, so attribution cannot be dropped by a forgetful call site.
   * Use `recordSystemAction` when there is genuinely no user behind the action.
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
    // actorUserId is the identity the request was made *as* (the target, under
    // impersonation). The admin behind it gets its own column.
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
    const repository = repoFor(this.auditRepository, AuditLog, manager);
    return repository.save(repository.create({ ...row, createdAt: this.clock.now() }));
  }

  /**
   * Redact an email out of retained audit metadata. Only `metadata.email` is
   * touched — the rest of the row is the compliance record and must survive.
   */
  async scrubEmailFromMetadata(email: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.auditRepository, AuditLog, manager)
      .createQueryBuilder()
      .update(AuditLog)
      .set({ metadata: () => `jsonb_set("metadata", '{email}', '"[redacted]"')` })
      .where(`LOWER("metadata" ->> 'email') = LOWER(:email)`, { email })
      .execute();
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
