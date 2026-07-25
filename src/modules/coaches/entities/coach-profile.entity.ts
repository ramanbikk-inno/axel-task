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
import { User } from '../../users/entities/user.entity';

/** Employment state. Off-boarding keeps the row so history survives (US-01.08). */
export enum CoachStatus {
  Active = 'Active',
  Inactive = 'Inactive',
}

/**
 * A coach account's profile. Each coach works for exactly ONE trainer
 * (US-01.08), enforced by the unique user_id (one profile per coach account).
 */
@Entity({ name: 'coach_profiles' })
export class CoachProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Uniqueness is enforced by a *partial* index on the active rows
   * (uq_coach_profiles_active_user_id), not by a column-level unique here.
   * "One trainer per coach" is a rule about current employment; a total unique
   * index also forbade ever having worked for a previous trainer, so an
   * off-boarded coach could never be re-hired without deleting their history.
   */
  @Index('idx_coach_profiles_user_id')
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Index('idx_coach_profiles_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  @Column({ name: 'bio', type: 'text', nullable: true })
  bio!: string | null;

  @Column({ name: 'credentials', type: 'text', nullable: true })
  credentials!: string | null;

  @Column({ name: 'certifications', type: 'text', nullable: true })
  certifications!: string | null;

  @Column({ name: 'public_visible', type: 'boolean', default: false })
  publicVisible!: boolean;

  @Column({ name: 'status', type: 'text', default: CoachStatus.Active })
  status!: CoachStatus;

  @Column({ name: 'joined_at', type: 'timestamptz' })
  joinedAt!: Date;

  /** Set exactly when status is Inactive; a CHECK keeps the two in step. */
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
