import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The deletion compliance record: original user id and email, who deleted, why,
 * when, and a backup of the original data.
 *
 * Kept out of audit_logs on purpose — that is a general activity feed with an
 * unshaped metadata column, and this row carries removed PII under a different
 * retention rule.
 */
export class CreateUserDeletionLogs1700001300000 implements MigrationInterface {
  name = 'CreateUserDeletionLogs1700001300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_deletion_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "original_email" text NOT NULL,
        "original_first_name" text,
        "original_last_name" text,
        "original_phone" text,
        "original_role" text NOT NULL,
        "deleted_by_user_id" uuid,
        "reason" text NOT NULL,
        "deleted_at" timestamptz NOT NULL,
        "original_data" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_deletion_logs_id" PRIMARY KEY ("id")
      )
    `);
    // No foreign keys, for the same reason audit_logs has none: the record has
    // to outlive anything it points at.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_user_deletion_logs_user_id" ON "user_deletion_logs" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_user_deletion_logs_deleted_at" ON "user_deletion_logs" ("deleted_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_deletion_logs"`);
  }
}
