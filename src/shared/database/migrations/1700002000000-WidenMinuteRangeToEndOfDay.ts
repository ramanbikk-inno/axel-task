import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Minute ranges are half-open: a slot [start, end) covers up to end-1. Capping
 * end at 1439 therefore left the last minute of every day uncoverable, and made
 * "available all day" inexpressible — the widest window the schema allowed was
 * 23h59m. The exclusive end of a full day is 1440.
 *
 * Both tables move together. Only widening the slots table would still fail the
 * override insert, which is the second half of the same assignment flow.
 */
export class WidenMinuteRangeToEndOfDay1700002000000 implements MigrationInterface {
  name = 'WidenMinuteRangeToEndOfDay1700002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "availability_slots" DROP CONSTRAINT "CHK_availability_slots_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ADD CONSTRAINT "CHK_availability_slots_range"
         CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")`,
    );

    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides"
         DROP CONSTRAINT "CHK_coach_availability_overrides_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides"
         ADD CONSTRAINT "CHK_coach_availability_overrides_range"
         CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows written against the wider bound would fail the narrower constraint,
    // so bring them back inside it before restoring it.
    await queryRunner.query(
      `UPDATE "availability_slots" SET "end_minute" = 1439 WHERE "end_minute" > 1439`,
    );
    await queryRunner.query(
      `UPDATE "coach_availability_overrides" SET "end_minute" = 1439 WHERE "end_minute" > 1439`,
    );

    await queryRunner.query(
      `ALTER TABLE "availability_slots" DROP CONSTRAINT "CHK_availability_slots_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "availability_slots" ADD CONSTRAINT "CHK_availability_slots_range"
         CHECK ("start_minute" >= 0 AND "end_minute" <= 1439 AND "start_minute" < "end_minute")`,
    );

    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides"
         DROP CONSTRAINT "CHK_coach_availability_overrides_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides"
         ADD CONSTRAINT "CHK_coach_availability_overrides_range"
         CHECK ("start_minute" >= 0 AND "end_minute" <= 1439 AND "start_minute" < "end_minute")`,
    );
  }
}
