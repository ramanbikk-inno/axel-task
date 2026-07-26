import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Coach availability ("My Times") and the audit trail for scheduling over it.
 *
 * `availability_slots` had a NOT NULL FK to `player_profiles`, so coach rows had
 * nowhere to live. Rather than a parallel table with duplicate validation, the
 * owner becomes an XOR. `is_available` and `updated_at` fold into the same
 * rewrite to avoid a second ALTER later.
 */
export class CoachAvailabilityAndOverrides1700000900000 implements MigrationInterface {
  name = 'CoachAvailabilityAndOverrides1700000900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ALTER COLUMN "player_profile_id" DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "availability_slots" ADD COLUMN "coach_profile_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "availability_slots"
        ADD CONSTRAINT "FK_availability_slots_coach" FOREIGN KEY ("coach_profile_id")
          REFERENCES "coach_profiles"("id") ON DELETE CASCADE
    `);
    // Exactly one owner. Without this the nullable columns would allow an
    // orphan row owned by nobody, or a row owned by both a player and a coach.
    await queryRunner.query(`
      ALTER TABLE "availability_slots"
        ADD CONSTRAINT "CHK_availability_slots_owner"
        CHECK (num_nonnulls("player_profile_id", "coach_profile_id") = 1)
    `);
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ADD COLUMN "is_available" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_availability_slots_coach_profile_id" ON "availability_slots" ("coach_profile_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "coach_availability_overrides" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid,
        "coach_profile_id" uuid NOT NULL,
        "trainer_profile_id" uuid NOT NULL,
        "day_of_week" smallint NOT NULL,
        "start_minute" integer NOT NULL,
        "end_minute" integer NOT NULL,
        "override_reason" text NOT NULL,
        "overridden_by_user_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coach_availability_overrides_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_coach_availability_overrides_coach" FOREIGN KEY ("coach_profile_id")
          REFERENCES "coach_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_coach_availability_overrides_trainer" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_coach_availability_overrides_actor" FOREIGN KEY ("overridden_by_user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_coach_availability_overrides_day"
          CHECK ("day_of_week" >= 0 AND "day_of_week" <= 6),
        CONSTRAINT "CHK_coach_availability_overrides_range"
          CHECK ("start_minute" >= 0 AND "end_minute" <= 1439 AND "start_minute" < "end_minute"),
        CONSTRAINT "CHK_coach_availability_overrides_reason"
          CHECK (length(btrim("override_reason")) > 0)
      )
    `);
    // The audit trail is read per coach (their own history) and per trainer
    // (the org's history); both are covered by these two indexes.
    await queryRunner.query(
      `CREATE INDEX "idx_coach_overrides_coach_profile_id" ON "coach_availability_overrides" ("coach_profile_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_coach_overrides_trainer_profile_id" ON "coach_availability_overrides" ("trainer_profile_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coach_availability_overrides"`);
    await queryRunner.query(`DROP INDEX "idx_availability_slots_coach_profile_id"`);
    // Coach-owned rows cannot be represented by the pre-migration schema, so
    // reverting discards them; that is the only way back to a NOT NULL
    // player_profile_id.
    await queryRunner.query(
      `DELETE FROM "availability_slots" WHERE "coach_profile_id" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "availability_slots" DROP COLUMN "updated_at"`);
    await queryRunner.query(`ALTER TABLE "availability_slots" DROP COLUMN "is_available"`);
    await queryRunner.query(
      `ALTER TABLE "availability_slots" DROP CONSTRAINT "CHK_availability_slots_owner"`,
    );
    await queryRunner.query(
      `ALTER TABLE "availability_slots" DROP CONSTRAINT "FK_availability_slots_coach"`,
    );
    await queryRunner.query(`ALTER TABLE "availability_slots" DROP COLUMN "coach_profile_id"`);
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ALTER COLUMN "player_profile_id" SET NOT NULL`,
    );
  }
}
