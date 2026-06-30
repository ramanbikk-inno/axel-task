import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTrainerProfiles1700000200000 implements MigrationInterface {
  name = 'CreateTrainerProfiles1700000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trainer_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "business_name" text NOT NULL,
        "website" text,
        "address" text,
        "description" text,
        "stripe_account_id" text,
        "subscription_status" text,
        "platform_fee_percent" numeric(5,2),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trainer_profiles_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_trainer_profiles_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_trainer_profiles_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE RESTRICT
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trainer_profiles"`);
  }
}
