import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Append-only administrative audit trail. Records sensitive operations such as
 * trainer creation (US-01.01), user deactivation/reactivation (US-01.12) and
 * user deletion (US-01.13). Rows are never updated or removed so history is
 * preserved for compliance even after the referenced users are anonymized.
 */
@Entity({ name: 'audit_logs' })
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_audit_logs_action')
  @Column({ type: 'text' })
  action!: string;

  @Index('idx_audit_logs_actor_user_id')
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Index('idx_audit_logs_target_user_id')
  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
