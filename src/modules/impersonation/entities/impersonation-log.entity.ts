import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Audit trail for Super Admin impersonation sessions (US-01.07): who
 * impersonated whom, when it started/ended, and how long it lasted.
 */
@Entity({ name: 'impersonation_logs' })
export class ImpersonationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_impersonation_logs_admin')
  @Column({ name: 'admin_user_id', type: 'uuid' })
  adminUserId!: string;

  @Index('idx_impersonation_logs_target')
  @Column({ name: 'target_user_id', type: 'uuid' })
  targetUserId!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds!: number | null;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
