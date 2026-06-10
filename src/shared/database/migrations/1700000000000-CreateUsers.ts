import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext";`);

    await queryRunner.query(
      `CREATE TYPE "users_role_enum" AS ENUM ('SuperAdmin', 'Trainer', 'Coach', 'PlayerParent');`,
    );
    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM ('Active', 'Inactive', 'Deleted');`,
    );

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" citext NOT NULL,
        "password_hash" text,
        "role" "users_role_enum" NOT NULL,
        "status" "users_status_enum" NOT NULL DEFAULT 'Active',
        "email_verified" boolean NOT NULL DEFAULT false,
        "email_verified_at" timestamptz,
        "must_set_password" boolean NOT NULL DEFAULT false,
        "is_child_account" boolean NOT NULL DEFAULT false,
        "first_name" text,
        "last_name" text,
        "phone" text,
        "photo_url" text,
        "token_version" int NOT NULL DEFAULT 0,
        "last_login_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "pk_users_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email");`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_email";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_status_enum";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum";`);
  }
}
