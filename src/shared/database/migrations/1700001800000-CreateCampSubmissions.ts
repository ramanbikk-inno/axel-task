import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Camp / evaluation form submissions, so a registration that follows one can be
 * pre-filled rather than retyped, and so a trainer can chase the ones that never
 * converted.
 */
export class CreateCampSubmissions1700001800000 implements MigrationInterface {
  name = 'CreateCampSubmissions1700001800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "camp_submissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "trainer_profile_id" uuid NOT NULL,
        "token" text NOT NULL,
        "first_name" text NOT NULL,
        "last_name" text,
        "email" citext NOT NULL,
        "phone" text,
        "player_name" text,
        "birth_date" date,
        "gender" text,
        "converted_user_id" uuid,
        "converted_at" timestamptz,
        "share_link_sent_at" timestamptz,
        "submitted_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_camp_submissions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_camp_submissions_trainer_profile" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_camp_submissions_converted_user" FOREIGN KEY ("converted_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // The token is the only thing guarding the pre-fill payload, so it is
    // looked up on every read of it and must be unique.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_camp_submissions_token" ON "camp_submissions" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_camp_submissions_trainer_profile_id"
         ON "camp_submissions" ("trainer_profile_id")`,
    );
    // Erasure sweeps copies of an address that live outside `users`.
    await queryRunner.query(
      `CREATE INDEX "idx_camp_submissions_email" ON "camp_submissions" ("email")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "camp_submissions"`);
  }
}
