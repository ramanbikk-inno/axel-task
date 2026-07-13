import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { AuditLog } from './entities/audit-log.entity';

export interface RecordAuditInput {
  action: string;
  actorUserId?: string | null;
  targetUserId?: string | null;
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
    const repository: Repository<AuditLog> =
      manager !== undefined ? manager.getRepository(AuditLog) : this.auditRepository;
    const row: AuditLog = repository.create({
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      targetUserId: input.targetUserId ?? null,
      metadata: input.metadata ?? null,
      createdAt: this.clock.now(),
    });
    return repository.save(row);
  }

  async findByTarget(targetUserId: string): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { targetUserId },
      order: { createdAt: 'DESC' },
    });
  }
}
