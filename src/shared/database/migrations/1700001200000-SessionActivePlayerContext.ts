import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A context in Epic-01 is a *pair* — "Alex → Coach Bob", "Sarah (Me) → Coach
 * Lisa" — not a trainer on its own. `auth_session` only held the trainer, so a
 * parent whose two children both train with the same trainer had no way to say
 * which of them they were looking at.
 */
export class SessionActivePlayerContext1700001200000 implements MigrationInterface {
  name = 'SessionActivePlayerContext1700001200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_session" ADD COLUMN "active_player_profile_id" uuid`,
    );
    // SET NULL, not CASCADE: removing a child profile must drop the parent back
    // to "no context selected", never delete the session they are sitting in.
    await queryRunner.query(`
      ALTER TABLE "auth_session"
        ADD CONSTRAINT "FK_auth_session_active_player_profile_id"
        FOREIGN KEY ("active_player_profile_id")
        REFERENCES "player_profiles"("id") ON DELETE SET NULL
    `);
    // Half a context is not a context: either both are set or neither is.
    await queryRunner.query(`
      ALTER TABLE "auth_session"
        ADD CONSTRAINT "CHK_auth_session_context_pair"
        CHECK (num_nonnulls("active_player_profile_id", "active_trainer_profile_id") <> 1)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_session" DROP CONSTRAINT "CHK_auth_session_context_pair"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_session" DROP CONSTRAINT "FK_auth_session_active_player_profile_id"`,
    );
    await queryRunner.query(`ALTER TABLE "auth_session" DROP COLUMN "active_player_profile_id"`);
  }
}
