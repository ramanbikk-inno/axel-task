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
 * Free-form by design: the spec asks for "emergency contact info" without
 * fixing a shape, and nothing queries into it.
 */
export interface EmergencyContact {
  name?: string;
  phone?: string;
  relationship?: string;
}

/**
 * A trainee profile owned by a user account. The account holder has one "self"
 * profile (isChild=false); parents additionally own one profile per child
 * (isChild=true). Associations to trainers live in trainer_player_associations.
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

  /**
   * The child's own login account, when one has been issued. Null
   * for every adult profile and for children who only ever appear through
   * their parent. A database CHECK keeps it null unless isChild is true.
   */
  @Column({ name: 'child_user_id', type: 'uuid', nullable: true })
  childUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'child_user_id' })
  childUser!: User | null;

  /** Per child, default OFF: token spending still needs a parent's approval. */
  @Column({ name: 'allow_child_token_spend_no_approval', type: 'boolean', default: false })
  allowChildTokenSpendNoApproval!: boolean;

  /** Set by the trainer, not by the player. */
  @Column({ name: 'skill_level', type: 'text', nullable: true })
  skillLevel!: string | null;

  @Column({ name: 'emergency_contact', type: 'jsonb', nullable: true })
  emergencyContact!: EmergencyContact | null;

  /**
   * Only meaningful for isChild rows — the account holder's own photo is
   * users.photo_url, since account and player are the same identity for a self
   * profile.
   */
  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photoUrl!: string | null;

  @Column({ name: 'photo_public_id', type: 'text', nullable: true })
  photoPublicId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
