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

import { CoachProfile } from '../../coaches/entities/coach-profile.entity';
import { PlayerProfile } from '../../players/entities/player-profile.entity';

/**
 * A weekly availability window — "Best Times" for a player (US-01.09) or
 * "My Times" for a coach (US-01.10).
 *
 * Ownership is an XOR: exactly one of playerProfileId / coachProfileId is set,
 * enforced by CHK_availability_slots_owner. dayOfWeek is 0=Sunday..6=Saturday;
 * start/end are minutes from midnight. Each window is confined to a single day
 * (0 <= startMinute < endMinute <= 1439) and never crosses midnight. Same-day
 * overlaps within one availability class are rejected in the service layer; the
 * DB CHECK constraints enforce the numeric ranges as defense-in-depth.
 *
 * isAvailable=false marks a blackout that subtracts from the surrounding
 * available windows, which is how spec section 8's "available or not available"
 * is represented.
 */
@Entity({ name: 'availability_slots' })
export class AvailabilitySlot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_availability_slots_player_profile_id')
  @Column({ name: 'player_profile_id', type: 'uuid', nullable: true })
  playerProfileId!: string | null;

  @ManyToOne(() => PlayerProfile, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'player_profile_id' })
  playerProfile!: PlayerProfile | null;

  @Index('idx_availability_slots_coach_profile_id')
  @Column({ name: 'coach_profile_id', type: 'uuid', nullable: true })
  coachProfileId!: string | null;

  @ManyToOne(() => CoachProfile, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'coach_profile_id' })
  coachProfile!: CoachProfile | null;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  @Column({ name: 'start_minute', type: 'int' })
  startMinute!: number;

  @Column({ name: 'end_minute', type: 'int' })
  endMinute!: number;

  @Column({ name: 'is_available', type: 'boolean', default: true })
  isAvailable!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
