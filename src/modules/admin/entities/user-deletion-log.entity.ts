import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { Role } from '../../users/entities/user.enums';

/**
 * The legal record of a GDPR erasure (US-01.13): "Deletion logged: Original
 * user ID, who deleted, when, reason (for legal compliance)".
 *
 * This is the one place the removed PII still exists. Everything else about
 * the account has been anonymised, so this row is what lets the platform prove
 * *which* account was erased, on whose instruction, and why — and it is
 * separable from the general audit trail, which has a different retention
 * decision attached to it.
 */
@Entity({ name: 'user_deletion_logs' })
export class UserDeletionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_user_deletion_logs_user_id', { unique: true })
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'original_email', type: 'text' })
  originalEmail!: string;

  @Column({ name: 'original_first_name', type: 'text', nullable: true })
  originalFirstName!: string | null;

  @Column({ name: 'original_last_name', type: 'text', nullable: true })
  originalLastName!: string | null;

  @Column({ name: 'original_phone', type: 'text', nullable: true })
  originalPhone!: string | null;

  @Column({ name: 'original_role', type: 'text' })
  originalRole!: Role;

  /** Null only if the deletion was performed by the system rather than a person. */
  @Column({ name: 'deleted_by_user_id', type: 'uuid', nullable: true })
  deletedByUserId!: string | null;

  @Column({ name: 'reason', type: 'text' })
  reason!: string;

  @Column({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date;

  /** Whatever else was erased, so the record is complete without new columns. */
  @Column({ name: 'original_data', type: 'jsonb', nullable: true })
  originalData!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
