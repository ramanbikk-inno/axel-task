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
import { PlayerProfile } from '../../players/entities/player-profile.entity';

/**
 * A weekly availability window — "Best Times" for a player, "My Times" for a
 * coach. Exactly one of playerProfileId / coachProfileId is set. dayOfWeek is
 * 0=Sunday; start/end are minutes from midnight and never cross it.
 * isAvailable=false is a blackout subtracting from the surrounding windows.
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

  /**
   * Rows are immutable: changing availability replaces the whole set, so this
   * is also the "last updated" time. A separate updated_at would only ever
   * equal it.
   */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
