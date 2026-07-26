import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three corrections to CoachAvailabilityAndOverrides, shipped separately because
 * that migration was already pushed:
 *
 * 1. `had_conflict` — without it the trail cannot tell a real override from a no-op.
 * 2. `availability_slots.updated_at` dropped; slots are replaced, never updated.
 * 3. An index for the platform-wide override trail, which has no org predicate.
 */
export class CoachOverrideConflictFlag1700001000000 implements MigrationInterface {
  name = 'CoachOverrideConflictFlag1700001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DEFAULT first so the column can be NOT NULL on a table that already has
    // rows, then dropped so every insert states the verdict explicitly.
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides" ADD COLUMN "had_conflict" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides" ALTER COLUMN "had_conflict" DROP DEFAULT`,
    );

    await queryRunner.query(`ALTER TABLE "availability_slots" DROP COLUMN IF EXISTS "updated_at"`);

    await queryRunner.query(
      `CREATE INDEX "idx_coach_overrides_created_at" ON "coach_availability_overrides" ("created_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_coach_overrides_created_at"`);
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides" DROP COLUMN "had_conflict"`,
    );
  }
}
