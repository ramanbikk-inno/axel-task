import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePlayersAndEnrollment1700000500000 implements MigrationInterface {
  name = 'CreatePlayersAndEnrollment1700000500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "player_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_user_id" uuid NOT NULL,
        "display_name" text NOT NULL,
        "is_child" boolean NOT NULL DEFAULT false,
        "birth_date" date,
        "gender" text,
        "school" text,
        "jersey_number" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "PK_player_profiles_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_player_profiles_owner" FOREIGN KEY ("owner_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_player_profiles_owner_user_id" ON "player_profiles" ("owner_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "share_links" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "trainer_profile_id" uuid NOT NULL,
        "code" text NOT NULL,
        "type" text NOT NULL,
        "target_email" text,
        "expires_at" timestamptz,
        "max_uses" integer,
        "use_count" integer NOT NULL DEFAULT 0,
        "active" boolean NOT NULL DEFAULT true,
        "created_by_user_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_share_links_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_share_links_trainer" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_share_links_code" ON "share_links" ("code")`);
    await queryRunner.query(
      `CREATE INDEX "idx_share_links_trainer_profile_id" ON "share_links" ("trainer_profile_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "trainer_player_associations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "trainer_profile_id" uuid NOT NULL,
        "player_profile_id" uuid NOT NULL,
        "share_link_id" uuid,
        "status" text NOT NULL DEFAULT 'active',
        "connected_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trainer_player_associations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tpa_trainer" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tpa_player" FOREIGN KEY ("player_profile_id")
          REFERENCES "player_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tpa_share_link" FOREIGN KEY ("share_link_id")
          REFERENCES "share_links"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_trainer_player" ON "trainer_player_associations" ("trainer_profile_id", "player_profile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tpa_trainer_profile_id" ON "trainer_player_associations" ("trainer_profile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tpa_player_profile_id" ON "trainer_player_associations" ("player_profile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trainer_player_associations"`);
    await queryRunner.query(`DROP TABLE "share_links"`);
    await queryRunner.query(`DROP TABLE "player_profiles"`);
  }
}
