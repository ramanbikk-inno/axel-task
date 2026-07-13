import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * A trainee profile owned by a user account. The account holder has one "self"
 * profile (isChild=false); parents additionally own one profile per child
 * (isChild=true) — see US-01.03. Associations to trainers live in
 * trainer_player_associations.
 */
@Entity({ name: 'player_profiles' })
export class PlayerProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_player_profiles_owner_user_id')
  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_user_id' })
  owner!: User;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  @Column({ name: 'is_child', type: 'boolean', default: false })
  isChild!: boolean;

  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate!: string | null;

  @Column({ name: 'gender', type: 'text', nullable: true })
  gender!: string | null;

  @Column({ name: 'school', type: 'text', nullable: true })
  school!: string | null;

  @Column({ name: 'jersey_number', type: 'text', nullable: true })
  jerseyNumber!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
