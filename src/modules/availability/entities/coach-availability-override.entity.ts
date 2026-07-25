import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CoachProfile } from '../../coaches/entities/coach-profile.entity';
import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * US-01.10: a trainer may schedule a coach outside their stated availability,
 * but only with a reason, and the decision is logged — event_id, coach_id,
 * override_reason, overridden_by.
 *
 * eventId is a nullable stub: events arrive in Epic-02, so there is no table to
 * point a foreign key at yet. The column exists now so overrides recorded
 * during Epic-01 are not lost when scheduling lands, and the day/time of the
 * assignment is stored alongside it so the record is self-describing without
 * an events table to join.
 *
 * Append-only: nothing mutates a row once written.
 */
@Entity({ name: 'coach_availability_overrides' })
export class CoachAvailabilityOverride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId!: string | null;

  @Index('idx_coach_overrides_coach_profile_id')
  @Column({ name: 'coach_profile_id', type: 'uuid' })
  coachProfileId!: string;

  @ManyToOne(() => CoachProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coach_profile_id' })
  coachProfile!: CoachProfile;

  @Index('idx_coach_overrides_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  @Column({ name: 'start_minute', type: 'int' })
  startMinute!: number;

  @Column({ name: 'end_minute', type: 'int' })
  endMinute!: number;

  @Column({ name: 'override_reason', type: 'text' })
  overrideReason!: string;

  @Column({ name: 'overridden_by_user_id', type: 'uuid' })
  overriddenByUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'overridden_by_user_id' })
  overriddenBy!: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
