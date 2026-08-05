import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `autoApproved` was computed at request time and never stored, so every read
 * after the create response reported false — a spend that bypassed the parent
 * was indistinguishable from one they granted. It cannot be derived after the
 * fact: status and responded_at are identical for both cases, and the setting
 * behind it is mutable, so recomputing would rewrite answered history.
 *
 * Existing rows backfill to false. The fact was never recorded for them, though
 * `audit_logs` metadata carries it if that history is ever needed.
 */
export class AddAutoApprovedToPurchaseApprovals1700001900000 implements MigrationInterface {
  name = 'AddAutoApprovedToPurchaseApprovals1700001900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "purchase_approvals"
         ADD COLUMN "auto_approved" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "purchase_approvals" DROP COLUMN "auto_approved"`);
  }
}
