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

import { TrainerProfile } from '../../trainers/entities/trainer-profile.entity';

/**
 * A scheduled session, carried at the depth this epic needs: something a coach
 * can be assigned to and a purchase can refer to. Rosters, capacity, recurrence
 * and pricing are not modelled here.
 */
@Entity({ name: 'events' })
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_events_trainer_profile_id')
  @Column({ name: 'trainer_profile_id', type: 'uuid' })
  trainerProfileId!: string;

  @ManyToOne(() => TrainerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trainer_profile_id' })
  trainerProfile!: TrainerProfile;

  @Column({ name: 'title', type: 'text' })
  title!: string;

  @Index('idx_events_starts_at')
  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  /** Price in minor units, so a child's purchase request has an amount to carry. */
  @Column({ name: 'price_cents', type: 'int', nullable: true })
  priceCents!: number | null;

  /** Cost in tokens, for the token-spend path. */
  @Column({ name: 'price_tokens', type: 'int', nullable: true })
  priceTokens!: number | null;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
