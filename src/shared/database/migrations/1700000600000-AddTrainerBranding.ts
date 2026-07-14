import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTrainerBranding1700000600000 implements MigrationInterface {
  name = 'AddTrainerBranding1700000600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trainer_profiles" ADD COLUMN "logo_url" text`);
    await queryRunner.query(`ALTER TABLE "trainer_profiles" ADD COLUMN "primary_color" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trainer_profiles" DROP COLUMN "primary_color"`);
    await queryRunner.query(`ALTER TABLE "trainer_profiles" DROP COLUMN "logo_url"`);
  }
}
