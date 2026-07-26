import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'auth_session' })
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /**
   * The selected context, as a pair. A context in Epic-01 is "which of my
   * profiles, with which trainer" — the trainer alone is ambiguous for a parent
   * whose children share one. Both null means nothing is selected yet; a
   * CHECK forbids setting only one.
   */
  @Column({ name: 'active_trainer_profile_id', type: 'uuid', nullable: true })
  activeTrainerProfileId!: string | null;

  @Column({ name: 'active_player_profile_id', type: 'uuid', nullable: true })
  activePlayerProfileId!: string | null;

  /**
   * When set, this session is a Super Admin impersonation session and this
   * column holds the impersonating admin's user id.
   */
  @Column({ name: 'impersonated_by', type: 'uuid', nullable: true })
  impersonatedBy!: string | null;

  /**
   * Hard session expiry. Normal login sessions leave this null (bounded only by
   * the refresh-token lifetime); impersonation sessions set it to +1 hour.
   */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'ip', type: 'text', nullable: true })
  ip!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_reason', type: 'text', nullable: true })
  revokedReason!: string | null;
}
