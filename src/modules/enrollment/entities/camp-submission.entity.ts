import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';
import { User } from '../../users/entities/user.entity';

/**
 * What someone typed on a camp or evaluation form before they had an account.
 * Held so the registration that follows can be pre-filled instead of retyped,
 * and so the trainer can chase the ones that never converted.
 */
@Entity({ name: 'camp_submissions' })
export class CampSubmission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_camp_submissions_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  /**
   * The unguessable handle in the "finish signing up" link. Separate from the
   * id so a sequential scan of ids cannot read strangers' contact details.
   */
  @Index('uq_camp_submissions_token', { unique: true })
  @Column({ name: 'token', type: 'text' })
  token!: string;

  @Column({ name: 'first_name', type: 'text' })
  firstName!: string;

  @Column({ name: 'last_name', type: 'text', nullable: true })
  lastName!: string | null;

  @Index('idx_camp_submissions_email')
  @Column({ name: 'email', type: 'citext' })
  email!: string;

  @Column({ name: 'phone', type: 'text', nullable: true })
  phone!: string | null;

  /** The player the form was about, when a parent filled it in for a child. */
  @Column({ name: 'player_name', type: 'text', nullable: true })
  playerName!: string | null;

  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate!: string | null;

  @Column({ name: 'gender', type: 'text', nullable: true })
  gender!: string | null;

  /** The account this became, once the submitter registered. */
  @Column({ name: 'converted_user_id', type: 'uuid', nullable: true })
  convertedUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'converted_user_id' })
  convertedUser!: User | null;

  @Column({ name: 'converted_at', type: 'timestamptz', nullable: true })
  convertedAt!: Date | null;

  /** When the trainer last mailed them their ShareLink, if ever. */
  @Column({ name: 'share_link_sent_at', type: 'timestamptz', nullable: true })
  shareLinkSentAt!: Date | null;

  @CreateDateColumn({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt!: Date;
}
