import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Follow-up to CoachAvailabilityAndOverrides (1700000900000), which was already
 * pushed. Editing that migration in place would have been invisible to any
 * database that had already recorded it as run, so these three corrections ship
 * as their own migration:
 *
 * 1. `coach_availability_overrides.had_conflict` — whether the window actually
 *    clashed with the coach's stated availability when the override was
 *    recorded. Without it the trail cannot tell a real override from a no-op.
 * 2. `availability_slots.updated_at` is dropped: a slot row is never updated,
 *    only replaced as part of a whole-set write, so it never diverged from
 *    `created_at`.
 * 3. An index for the Super Admin's platform-wide override trail, which has no
 *    org predicate and so cannot use either of the existing composite indexes.
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
