import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Columns the data model was missing. Schema only — every column is nullable or
 * defaulted, so nothing behaves differently until the code consuming them lands.
 * Grouped into one migration because splitting them would leave the schema in
 * states no code targets.
 */
export class Epic01SchemaCompletion1700001100000 implements MigrationInterface {
  name = 'Epic01SchemaCompletion1700001100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- player_profiles: the child account link and the trainee fields ---

    // A child profile may have its own login. Nullable because most
    // child profiles never get one, and UNIQUE because one user account cannot
    // be two children. SET NULL rather than CASCADE: deleting the login must
    // not take the training history with it.
    await queryRunner.query(`ALTER TABLE "player_profiles" ADD COLUMN "child_user_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "player_profiles"
        ADD CONSTRAINT "FK_player_profiles_child_user_id"
        FOREIGN KEY ("child_user_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_player_profiles_child_user_id"
        ON "player_profiles" ("child_user_id")
        WHERE "child_user_id" IS NOT NULL
    `);
    // An adult's own profile must never carry a child login. Without this the
    // child-permission checks could be turned on for a parent by
    // writing one column.
    await queryRunner.query(`
      ALTER TABLE "player_profiles"
        ADD CONSTRAINT "CHK_player_profiles_child_user_requires_child"
        CHECK ("child_user_id" IS NULL OR "is_child" = true)
    `);

    // Token approval is per child, default OFF.
    await queryRunner.query(`
      ALTER TABLE "player_profiles"
        ADD COLUMN "allow_child_token_spend_no_approval" boolean NOT NULL DEFAULT false
    `);
    // Set by the trainer, not the player.
    await queryRunner.query(`ALTER TABLE "player_profiles" ADD COLUMN "skill_level" text`);
    // jsonb rather than three columns: the shape (name/phone/relationship) is
    // not fixed by the spec and is never queried on.
    await queryRunner.query(`ALTER TABLE "player_profiles" ADD COLUMN "emergency_contact" jsonb`);

    // --- coach_profiles: a lifecycle, so a coach can be off-boarded ---

    await queryRunner.query(`
      ALTER TABLE "coach_profiles"
        ADD COLUMN "status" text NOT NULL DEFAULT 'Active'
    `);
    await queryRunner.query(`
      ALTER TABLE "coach_profiles"
        ADD CONSTRAINT "CHK_coach_profiles_status"
        CHECK ("status" IN ('Active', 'Inactive'))
    `);
    await queryRunner.query(`ALTER TABLE "coach_profiles" ADD COLUMN "ended_at" timestamptz`);
    await queryRunner.query(`
      ALTER TABLE "coach_profiles"
        ADD CONSTRAINT "CHK_coach_profiles_ended_at_matches_status"
        CHECK (("status" = 'Active') = ("ended_at" IS NULL))
    `);

    // "Each coach works for exactly ONE trainer" is a rule about *current*
    // employment. The old total UNIQUE(user_id) also forbade ever having worked
    // for a previous one, so an off-boarded coach could never be re-hired and
    // their history could never be kept. Narrow it to active rows.
    await queryRunner.query(`DROP INDEX "uq_coach_profiles_user_id"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_coach_profiles_active_user_id"
        ON "coach_profiles" ("user_id")
        WHERE "status" = 'Active'
    `);

    // --- audit_logs: attribution and a non-user target ---

    // Actions taken *during* an impersonation have to be
    // attributable to the admin behind them. actor_user_id is the impersonated
    // user, which is the truth about who the request claimed to be but not
    // about who was at the keyboard.
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD COLUMN "on_behalf_of_admin_id" uuid`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD COLUMN "impersonation_session_id" uuid`);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_logs_on_behalf_of_admin_id"
        ON "audit_logs" ("on_behalf_of_admin_id")
        WHERE "on_behalf_of_admin_id" IS NOT NULL
    `);

    // target_user_id only ever described a user. Coach profiles, share links
    // and player profiles are audited too, and were being squeezed into
    // metadata where nothing can index or query them.
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD COLUMN "target_type" text`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD COLUMN "target_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
        ADD CONSTRAINT "CHK_audit_logs_target_pair"
        CHECK (num_nonnulls("target_type", "target_id") <> 1)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_audit_logs_target"
        ON "audit_logs" ("target_type", "target_id")
        WHERE "target_type" IS NOT NULL
    `);
    // Reading an audit trail means "what happened, most recent first".
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" ("created_at" DESC, "id" DESC)`,
    );

    // --- stored-asset public ids ---

    // The URL is what gets served; the public id is what the provider needs to
    // *delete* the old asset when one is replaced. Storing only the URL meant
    // every re-upload orphaned the previous file for good.
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "photo_public_id" text`);
    await queryRunner.query(`ALTER TABLE "trainer_profiles" ADD COLUMN "logo_public_id" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trainer_profiles" DROP COLUMN "logo_public_id"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "photo_public_id"`);

    await queryRunner.query(`DROP INDEX "idx_audit_logs_created_at"`);
    await queryRunner.query(`DROP INDEX "idx_audit_logs_target"`);
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT "CHK_audit_logs_target_pair"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "target_id"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "target_type"`);
    await queryRunner.query(`DROP INDEX "idx_audit_logs_on_behalf_of_admin_id"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "impersonation_session_id"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "on_behalf_of_admin_id"`);

    // Reverting to a total unique index would fail against data this migration
    // made legal, so drop the duplicates down to the active row first.
    await queryRunner.query(`DROP INDEX "uq_coach_profiles_active_user_id"`);
    await queryRunner.query(`
      DELETE FROM "coach_profiles" a
        USING "coach_profiles" b
        WHERE a."user_id" = b."user_id"
          AND a."status" <> 'Active'
          AND b."status" = 'Active'
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_coach_profiles_user_id" ON "coach_profiles" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "coach_profiles" DROP CONSTRAINT "CHK_coach_profiles_ended_at_matches_status"`,
    );
    await queryRunner.query(`ALTER TABLE "coach_profiles" DROP COLUMN "ended_at"`);
    await queryRunner.query(
      `ALTER TABLE "coach_profiles" DROP CONSTRAINT "CHK_coach_profiles_status"`,
    );
    await queryRunner.query(`ALTER TABLE "coach_profiles" DROP COLUMN "status"`);

    await queryRunner.query(`ALTER TABLE "player_profiles" DROP COLUMN "emergency_contact"`);
    await queryRunner.query(`ALTER TABLE "player_profiles" DROP COLUMN "skill_level"`);
    await queryRunner.query(
      `ALTER TABLE "player_profiles" DROP COLUMN "allow_child_token_spend_no_approval"`,
    );
    await queryRunner.query(
      `ALTER TABLE "player_profiles" DROP CONSTRAINT "CHK_player_profiles_child_user_requires_child"`,
    );
    await queryRunner.query(`DROP INDEX "uq_player_profiles_child_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "player_profiles" DROP CONSTRAINT "FK_player_profiles_child_user_id"`,
    );
    await queryRunner.query(`ALTER TABLE "player_profiles" DROP COLUMN "child_user_id"`);
  }
}
