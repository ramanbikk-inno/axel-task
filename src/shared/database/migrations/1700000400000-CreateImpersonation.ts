import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateImpersonation1700000400000 implements MigrationInterface {
  name = 'CreateImpersonation1700000400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth_session" ADD COLUMN "impersonated_by" uuid`);
    await queryRunner.query(`ALTER TABLE "auth_session" ADD COLUMN "expires_at" timestamptz`);

    await queryRunner.query(`
      CREATE TABLE "impersonation_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "admin_user_id" uuid NOT NULL,
        "target_user_id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "started_at" timestamptz NOT NULL,
        "ended_at" timestamptz,
        "duration_seconds" integer,
        "reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_impersonation_logs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_impersonation_logs_admin" ON "impersonation_logs" ("admin_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_impersonation_logs_target" ON "impersonation_logs" ("target_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "impersonation_logs"`);
    await queryRunner.query(`ALTER TABLE "auth_session" DROP COLUMN "expires_at"`);
    await queryRunner.query(`ALTER TABLE "auth_session" DROP COLUMN "impersonated_by"`);
  }
}
