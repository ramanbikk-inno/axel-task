import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { dataSourceOptionsForUrl } from '../../src/shared/database/data-source';

/**
 * The Epic-01 schema-completion migration adds constraints, not code, so this
 * asserts them against real Postgres. Every case here is a rule the database
 * has to hold on its own — application logic cannot be trusted to be the only
 * writer, and several of these exist precisely because a single stray UPDATE
 * would otherwise re-open a permission hole.
 */
jest.setTimeout(180000);

describe('Epic-01 schema completion (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let parentUserId: string;
  let trainerProfileId: string;

  const newUser = async (label: string): Promise<string> => {
    const rows: Array<{ id: string }> = await ds.query(
      `INSERT INTO users (email, role, status, email_verified, must_set_password, token_version)
       VALUES ($1, 'PlayerParent', 'Active', true, false, 0) RETURNING id`,
      [`${label}-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return rows[0].id;
  };

  const newProfile = async (over: Record<string, unknown> = {}): Promise<string> => {
    const isChild = over.is_child ?? true;
    const childUserId = over.child_user_id ?? null;
    const rows: Array<{ id: string }> = await ds.query(
      `INSERT INTO player_profiles (owner_user_id, display_name, is_child, child_user_id)
       VALUES ($1, 'Kid', $2, $3) RETURNING id`,
      [parentUserId, isChild, childUserId],
    );
    return rows[0].id;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('axel_schema')
      .withUsername('axel')
      .withPassword('axel')
      .start();

    ds = new DataSource(dataSourceOptionsForUrl(container.getConnectionUri()));
    await ds.initialize();
    await ds.runMigrations();

    parentUserId = await newUser('parent');
    const trainerUserId = await newUser('trainer');
    const trainerRows: Array<{ id: string }> = await ds.query(
      `INSERT INTO trainer_profiles (user_id, business_name) VALUES ($1, 'Org') RETURNING id`,
      [trainerUserId],
    );
    trainerProfileId = trainerRows[0].id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await container.stop();
  });

  describe('player_profiles.child_user_id', () => {
    it('accepts a child login on a child profile', async () => {
      const childUserId = await newUser('child');
      await expect(newProfile({ child_user_id: childUserId })).resolves.toEqual(expect.any(String));
    });

    it('refuses a child login on an adult profile', async () => {
      // Otherwise the child-permission branch could be switched on for a
      // parent by writing one column.
      const childUserId = await newUser('adult-child');
      await expect(newProfile({ is_child: false, child_user_id: childUserId })).rejects.toThrow(
        /CHK_player_profiles_child_user_requires_child/,
      );
    });

    it('refuses the same login on two child profiles', async () => {
      const childUserId = await newUser('shared');
      await newProfile({ child_user_id: childUserId });
      await expect(newProfile({ child_user_id: childUserId })).rejects.toThrow(
        /uq_player_profiles_child_user_id/,
      );
    });

    it('allows many profiles with no child login at all', async () => {
      // A total unique index would have collapsed every NULL into one row.
      await newProfile();
      await expect(newProfile()).resolves.toEqual(expect.any(String));
    });

    it('nulls the link rather than deleting the profile when the login goes', async () => {
      const childUserId = await newUser('vanishing');
      const profileId = await newProfile({ child_user_id: childUserId });

      await ds.query(`DELETE FROM users WHERE id = $1`, [childUserId]);

      const rows: Array<{ child_user_id: string | null }> = await ds.query(
        `SELECT child_user_id FROM player_profiles WHERE id = $1`,
        [profileId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].child_user_id).toBeNull();
    });

    it('defaults token spending to needing approval', async () => {
      const profileId = await newProfile();
      const rows: Array<{ allow_child_token_spend_no_approval: boolean }> = await ds.query(
        `SELECT allow_child_token_spend_no_approval FROM player_profiles WHERE id = $1`,
        [profileId],
      );
      expect(rows[0].allow_child_token_spend_no_approval).toBe(false);
    });
  });

  describe('coach_profiles employment', () => {
    const newCoach = async (
      userId: string,
      status: string,
      endedAt: string | null,
    ): Promise<void> => {
      await ds.query(
        `INSERT INTO coach_profiles (user_id, trainer_profile_id, status, joined_at, ended_at)
         VALUES ($1, $2, $3, now(), $4)`,
        [userId, trainerProfileId, status, endedAt],
      );
    };

    it('still refuses two active profiles for one coach', async () => {
      const userId = await newUser('coach-dup');
      await newCoach(userId, 'Active', null);
      await expect(newCoach(userId, 'Active', null)).rejects.toThrow(
        /uq_coach_profiles_active_user_id/,
      );
    });

    it('allows a re-hire alongside an ended engagement', async () => {
      // The whole point of the partial index: history survives off-boarding.
      const userId = await newUser('coach-rehire');
      await newCoach(userId, 'Inactive', new Date().toISOString());
      await expect(newCoach(userId, 'Active', null)).resolves.toBeUndefined();
    });

    it('allows several ended engagements for one coach', async () => {
      const userId = await newUser('coach-history');
      await newCoach(userId, 'Inactive', new Date().toISOString());
      await expect(newCoach(userId, 'Inactive', new Date().toISOString())).resolves.toBeUndefined();
    });

    it.each([
      ['Active with an end date', 'Active', new Date().toISOString()],
      ['Inactive with no end date', 'Inactive', null],
    ])('refuses a row that is %s', async (_label, status, endedAt) => {
      const userId = await newUser('coach-mismatch');
      await expect(newCoach(userId, status, endedAt)).rejects.toThrow(
        /CHK_coach_profiles_ended_at_matches_status/,
      );
    });

    it('refuses a status outside the enum', async () => {
      const userId = await newUser('coach-bogus');
      // ended_at is set so the status/ended_at pairing check is satisfied and
      // the enum check is the only one left that can reject this.
      await expect(newCoach(userId, 'Retired', new Date().toISOString())).rejects.toThrow(
        /CHK_coach_profiles_status/,
      );
    });
  });

  describe('audit_logs target pair', () => {
    const insert = (targetType: string | null, targetId: string | null): Promise<unknown> =>
      ds.query(`INSERT INTO audit_logs (action, target_type, target_id) VALUES ('x', $1, $2)`, [
        targetType,
        targetId,
      ]);

    it('accepts both set', async () => {
      await expect(insert('CoachProfile', trainerProfileId)).resolves.toBeDefined();
    });

    it('accepts neither set', async () => {
      await expect(insert(null, null)).resolves.toBeDefined();
    });

    it.each([
      ['a type with no id', 'CoachProfile', null],
      ['an id with no type', null, '11111111-1111-4111-8111-111111111111'],
    ])('refuses %s', async (_label, targetType, targetId) => {
      // A half-written target is unqueryable, which defeats the point of
      // moving these out of the metadata blob.
      await expect(insert(targetType, targetId)).rejects.toThrow(/CHK_audit_logs_target_pair/);
    });
  });
});
