import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Append-only administrative audit trail. Records sensitive operations such as
 * trainer creation, user deactivation/reactivation and
 * user deletion. Rows are never updated or removed so history is
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

  /**
   * The admin who was really at the keyboard, when the action was taken inside
   * an impersonation session. `actorUserId` stays the impersonated
   * user — that is the truth about who the request claimed to be — so both
   * questions can be answered from one row.
   */
  @Column({ name: 'on_behalf_of_admin_id', type: 'uuid', nullable: true })
  onBehalfOfAdminId!: string | null;

  @Column({ name: 'impersonation_session_id', type: 'uuid', nullable: true })
  impersonationSessionId!: string | null;

  /**
   * A target that is not a user — a coach profile, a share link, a player
   * profile. Set together with targetId or not at all (CHECK-enforced).
   */
  @Column({ name: 'target_type', type: 'text', nullable: true })
  targetType!: string | null;

  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
