import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAvailability1700000800000 implements MigrationInterface {
  name = 'CreateAvailability1700000800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "availability_slots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "player_profile_id" uuid NOT NULL,
        "day_of_week" smallint NOT NULL,
        "start_minute" integer NOT NULL,
        "end_minute" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_availability_slots_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_availability_slots_player" FOREIGN KEY ("player_profile_id")
          REFERENCES "player_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_availability_slots_day" CHECK ("day_of_week" >= 0 AND "day_of_week" <= 6),
        CONSTRAINT "CHK_availability_slots_range" CHECK ("start_minute" >= 0 AND "end_minute" <= 1439 AND "start_minute" < "end_minute")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_availability_slots_player_profile_id" ON "availability_slots" ("player_profile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "availability_slots"`);
  }
}
