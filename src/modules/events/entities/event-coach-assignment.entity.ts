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
import { Event } from './event.entity';

/**
 * A coach's own answer to being scheduled. The assignment stands either way —
 * "Coach sees assignment (no blocking), can accept or request change".
 */
export enum AssignmentResponse {
  Pending = 'pending',
  Accepted = 'accepted',
  ChangeRequested = 'change_requested',
}

@Entity({ name: 'event_coach_assignments' })
@Index('uq_event_coach_assignment', ['eventId', 'coachProfileId'], { unique: true })
export class EventCoachAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  @Index('idx_event_coach_assignments_coach_profile_id')
  @Column({ name: 'coach_profile_id', type: 'uuid' })
  coachProfileId!: string;

  @ManyToOne(() => CoachProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coach_profile_id' })
  coachProfile!: CoachProfile;

  @Column({ name: 'assigned_by_user_id', type: 'uuid' })
  assignedByUserId!: string;

  @Column({ name: 'response', type: 'text', default: AssignmentResponse.Pending })
  response!: AssignmentResponse;

  /** What the coach said when asking for a change; null until they do. */
  @Column({ name: 'coach_note', type: 'text', nullable: true })
  coachNote!: string | null;

  /**
   * Whether this assignment went against the coach's stated times. Denormalised
   * from the override row so the trainer's list does not need a join to show it.
   */
  @Column({ name: 'had_conflict', type: 'boolean', default: false })
  hadConflict!: boolean;

  /** The override that authorised a conflicting assignment; null when free. */
  @Column({ name: 'override_id', type: 'uuid', nullable: true })
  overrideId!: string | null;

  @CreateDateColumn({ name: 'assigned_at', type: 'timestamptz' })
  assignedAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
