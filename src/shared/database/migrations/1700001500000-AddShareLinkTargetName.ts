import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The optional invitee name a trainer may type on the coach invite form, so the
 * pending invitation reads as a person rather than only an address.
 */
export class AddShareLinkTargetName1700001500000 implements MigrationInterface {
  name = 'AddShareLinkTargetName1700001500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        ADD COLUMN "target_name" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        DROP COLUMN "target_name"
    `);
  }
}
