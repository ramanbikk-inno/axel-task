import { MigrationInterface, QueryRunner } from 'typeorm';

/** Mirrors users.photo_url / photo_public_id, scoped to a trainee profile. */
export class AddPlayerProfilePhoto1700001400000 implements MigrationInterface {
  name = 'AddPlayerProfilePhoto1700001400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "player_profiles"
        ADD COLUMN "photo_url" text,
        ADD COLUMN "photo_public_id" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "player_profiles"
        DROP COLUMN "photo_public_id",
        DROP COLUMN "photo_url"
    `);
  }
}
