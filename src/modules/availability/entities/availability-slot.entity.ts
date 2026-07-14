import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { PlayerProfile } from '../../players/entities/player-profile.entity';

/**
 * A weekly availability window ("Best Times", US-01.09) for a player profile.
 * dayOfWeek is 0=Sunday..6=Saturday; start/end are minutes from midnight.
 */
@Entity({ name: 'availability_slots' })
export class AvailabilitySlot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_availability_slots_player_profile_id')
  @Column({ name: 'player_profile_id', type: 'uuid' })
  playerProfileId!: string;

  @ManyToOne(() => PlayerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_profile_id' })
  playerProfile!: PlayerProfile;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  @Column({ name: 'start_minute', type: 'int' })
  startMinute!: number;

  @Column({ name: 'end_minute', type: 'int' })
  endMinute!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
