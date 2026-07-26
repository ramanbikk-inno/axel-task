import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity({ name: 'trainer_profiles' })
export class TrainerProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'business_name', type: 'text' })
  businessName!: string;

  @Column({ name: 'website', type: 'text', nullable: true })
  website!: string | null;

  @Column({ name: 'address', type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'stripe_account_id', type: 'text', nullable: true })
  stripeAccountId!: string | null;

  @Column({ name: 'subscription_status', type: 'text', nullable: true })
  subscriptionStatus!: string | null;

  @Column({ name: 'platform_fee_percent', type: 'numeric', precision: 5, scale: 2, nullable: true })
  platformFeePercent!: string | null;

  /** Portal branding. */
  @Column({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl!: string | null;

  /** Provider handle for the current logo, so a replacement can delete the old one. */
  @Column({ name: 'logo_public_id', type: 'text', nullable: true })
  logoPublicId!: string | null;

  @Column({ name: 'primary_color', type: 'text', nullable: true })
  primaryColor!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
