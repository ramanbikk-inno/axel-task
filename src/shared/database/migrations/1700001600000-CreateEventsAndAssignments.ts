import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Events at the depth Epic-01 needs: something a coach can be assigned to and a
 * purchase can refer to. Also gives `coach_availability_overrides.event_id` the
 * foreign key it has been missing since it was introduced.
 */
export class CreateEventsAndAssignments1700001600000 implements MigrationInterface {
  name = 'CreateEventsAndAssignments1700001600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "trainer_profile_id" uuid NOT NULL,
        "title" text NOT NULL,
        "starts_at" timestamptz NOT NULL,
        "ends_at" timestamptz NOT NULL,
        "price_cents" int,
        "price_tokens" int,
        "created_by_user_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_events" PRIMARY KEY ("id"),
        CONSTRAINT "fk_events_trainer_profile" FOREIGN KEY ("trainer_profile_id")
          REFERENCES "trainer_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_events_window" CHECK ("ends_at" > "starts_at")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_events_trainer_profile_id" ON "events" ("trainer_profile_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_events_starts_at" ON "events" ("starts_at")`);

    await queryRunner.query(`
      CREATE TABLE "event_coach_assignments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "coach_profile_id" uuid NOT NULL,
        "assigned_by_user_id" uuid NOT NULL,
        "response" text NOT NULL DEFAULT 'pending',
        "coach_note" text,
        "had_conflict" boolean NOT NULL DEFAULT false,
        "override_id" uuid,
        "assigned_at" timestamptz NOT NULL DEFAULT now(),
        "responded_at" timestamptz,
        CONSTRAINT "pk_event_coach_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "fk_event_coach_assignments_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_event_coach_assignments_coach" FOREIGN KEY ("coach_profile_id")
          REFERENCES "coach_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_event_coach_assignments_override" FOREIGN KEY ("override_id")
          REFERENCES "coach_availability_overrides"("id") ON DELETE SET NULL,
        CONSTRAINT "ck_event_coach_assignments_response"
          CHECK ("response" IN ('pending', 'accepted', 'change_requested'))
      )
    `);
    // One assignment per coach per event; a second is a client bug, not a state.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_event_coach_assignment"
         ON "event_coach_assignments" ("event_id", "coach_profile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_event_coach_assignments_coach_profile_id"
         ON "event_coach_assignments" ("coach_profile_id")`,
    );

    // The column was declared with no REFERENCES clause, so an override could
    // name an event id that never existed.
    await queryRunner.query(`
      ALTER TABLE "coach_availability_overrides"
        ADD CONSTRAINT "fk_coach_overrides_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "coach_availability_overrides" DROP CONSTRAINT "fk_coach_overrides_event"`,
    );
    await queryRunner.query(`DROP TABLE "event_coach_assignments"`);
    await queryRunner.query(`DROP TABLE "events"`);
  }
}
