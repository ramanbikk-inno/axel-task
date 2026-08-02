import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Event } from '../../events/entities/event.entity';
import { PlayerProfile } from '../../players/entities/player-profile.entity';
import { User } from '../../users/entities/user.entity';

/** USD always needs approval; tokens depend on the per-child setting. */
export enum PaymentType {
  Usd = 'usd',
  Tokens = 'tokens',
}

export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Denied = 'denied',
  /** Nobody acted inside the 48-hour window. */
  Expired = 'expired',
}

/**
 * One child's request to spend on one event, and the parent's answer.
 * Fields follow §8 "For Child Purchase Approvals" one for one.
 */
@Entity({ name: 'purchase_approvals' })
export class PurchaseApproval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_purchase_approvals_child_player_profile_id')
  @Column({ name: 'child_player_profile_id', type: 'uuid' })
  childPlayerProfileId!: string;

  @ManyToOne(() => PlayerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'child_player_profile_id' })
  childPlayerProfile!: PlayerProfile;

  /** The account that must answer — the profile's owner at request time. */
  @Index('idx_purchase_approvals_parent_user_id')
  @Column({ name: 'parent_user_id', type: 'uuid' })
  parentUserId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_user_id' })
  parentUser!: User;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event;

  /** Minor units for USD, whole tokens for the token path. */
  @Column({ name: 'amount', type: 'int' })
  amount!: number;

  @Column({ name: 'payment_type', type: 'text' })
  paymentType!: PaymentType;

  @Index('idx_purchase_approvals_status')
  @Column({ name: 'status', type: 'text', default: ApprovalStatus.Pending })
  status!: ApprovalStatus;

  /** "Parent can add notes when approving/denying any request". */
  @Column({ name: 'parent_notes', type: 'text', nullable: true })
  parentNotes!: string | null;

  @CreateDateColumn({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
