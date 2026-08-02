import { Column, CreateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Shared shape behind account setup, email verification and password reset
 * tokens — three tables, byte-identical apart from name. Concrete table
 * inheritance: each subclass still owns its own `@Entity` and table.
 */
export abstract class SingleUseTokenBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'token_hash', type: 'text', unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
