import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCoachProfiles1700000700000 implements MigrationInterface {
  name = 'CreateCoachProfiles1700000700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "coach_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "trainer_profile_id" uuid NOT NULL,
        "bio" text,
        "credentials" text,
        "certifications" text,
        "public_visible" boolean NOT NULL DEFAULT false,
        "joined_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coach_profiles_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_coach_profiles_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_coach_profiles_trainer" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_coach_profiles_user_id" ON "coach_profiles" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_coach_profiles_trainer_profile_id" ON "coach_profiles" ("trainer_profile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coach_profiles"`);
  }
}
