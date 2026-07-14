import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';

export enum ShareLinkType {
  /** Static player invite: unlimited uses, no expiry (US-01.02). */
  PlayerStatic = 'player_static',
  /** Unique coach invite: single use, 7-day expiry (US-01.08). */
  CoachUnique = 'coach_unique',
}

@Entity({ name: 'share_links' })
export class ShareLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_share_links_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  @Index('uq_share_links_code', { unique: true })
  @Column({ name: 'code', type: 'text' })
  code!: string;

  @Column({ name: 'type', type: 'text' })
  type!: ShareLinkType;

  @Column({ name: 'target_email', type: 'text', nullable: true })
  targetEmail!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'max_uses', type: 'int', nullable: true })
  maxUses!: number | null;

  @Column({ name: 'use_count', type: 'int', default: 0 })
  useCount!: number;

  @Column({ name: 'active', type: 'boolean', default: true })
  active!: boolean;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
