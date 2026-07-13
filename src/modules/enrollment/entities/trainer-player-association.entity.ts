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

import { PlayerProfile } from '../../players/entities/player-profile.entity';
import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';

export enum AssociationStatus {
  Active = 'active',
  Inactive = 'inactive',
}

/**
 * Links a player profile to a trainer's organization (US-01.02). A player can
 * be associated with multiple trainers; each pairing is unique.
 */
@Entity({ name: 'trainer_player_associations' })
@Index('uq_trainer_player', ['trainerProfileId', 'playerProfileId'], { unique: true })
export class TrainerPlayerAssociation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_tpa_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  @Index('idx_tpa_player_profile_id')
  @Column({ name: 'player_profile_id', type: 'uuid' })
  playerProfileId!: string;

  @ManyToOne(() => PlayerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_profile_id' })
  playerProfile!: PlayerProfile;

  @Column({ name: 'share_link_id', type: 'uuid', nullable: true })
  shareLinkId!: string | null;

  @Column({ name: 'status', type: 'text', default: AssociationStatus.Active })
  status!: AssociationStatus;

  @Column({ name: 'connected_at', type: 'timestamptz' })
  connectedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
