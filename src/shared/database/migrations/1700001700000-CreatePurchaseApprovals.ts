import { MigrationInterface, QueryRunner } from 'typeorm';

/** §8 "For Child Purchase Approvals", one column per stated requirement. */
export class CreatePurchaseApprovals1700001700000 implements MigrationInterface {
  name = 'CreatePurchaseApprovals1700001700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "purchase_approvals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "child_player_profile_id" uuid NOT NULL,
        "parent_user_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "amount" int NOT NULL,
        "payment_type" text NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "parent_notes" text,
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "responded_at" timestamptz,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "pk_purchase_approvals" PRIMARY KEY ("id"),
        CONSTRAINT "fk_purchase_approvals_child" FOREIGN KEY ("child_player_profile_id")
          REFERENCES "player_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_purchase_approvals_parent" FOREIGN KEY ("parent_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_purchase_approvals_event" FOREIGN KEY ("event_id")
          REFERENCES "events"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_purchase_approvals_payment_type"
          CHECK ("payment_type" IN ('usd', 'tokens')),
        CONSTRAINT "ck_purchase_approvals_status"
          CHECK ("status" IN ('pending', 'approved', 'denied', 'expired')),
        CONSTRAINT "ck_purchase_approvals_amount" CHECK ("amount" > 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_purchase_approvals_parent_user_id"
         ON "purchase_approvals" ("parent_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchase_approvals_child_player_profile_id"
         ON "purchase_approvals" ("child_player_profile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchase_approvals_status" ON "purchase_approvals" ("status")`,
    );
    // The parent's queue is read by (parent, status) on every list and before
    // every decision, to settle the 48-hour rule without a scheduler.
    await queryRunner.query(
      `CREATE INDEX "idx_purchase_approvals_pending_expiry"
         ON "purchase_approvals" ("parent_user_id", "expires_at")
         WHERE "status" = 'pending'`,
    );
    // A child cannot stack duplicate open requests for the same event.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_purchase_approvals_open_request"
         ON "purchase_approvals" ("child_player_profile_id", "event_id")
         WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "purchase_approvals"`);
  }
}
