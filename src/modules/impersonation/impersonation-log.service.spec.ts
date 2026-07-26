import { IsNull, Repository } from 'typeorm';

import { ImpersonationLogService } from './impersonation-log.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

const STARTED = new Date('2026-03-01T09:00:00.000Z');

const log = (over: Partial<ImpersonationLog> = {}): ImpersonationLog =>
  ({
    id: 'log-1',
    adminUserId: 'admin-1',
    targetUserId: 'target-1',
    sessionId: 'session-1',
    startedAt: STARTED,
    endedAt: null,
    durationSeconds: null,
    reason: null,
    ...over,
  }) as ImpersonationLog;

const makeService = (): {
  service: ImpersonationLogService;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  query: jest.Mock;
} => {
  const findOne = jest.fn().mockResolvedValue(null);
  const find = jest.fn().mockResolvedValue([]);
  const update = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn().mockResolvedValue(undefined);

  return {
    service: new ImpersonationLogService({
      findOne,
      find,
      update,
      query,
    } as unknown as Repository<ImpersonationLog>),
    findOne,
    find,
    update,
    query,
  };
};

describe('ImpersonationLogService (US-01.07)', () => {
  describe('closeForSession', () => {
    it('writes the end time and the elapsed duration', async () => {
      const { service, findOne, update } = makeService();
      findOne.mockResolvedValue(log());
      const endedAt = new Date(STARTED.getTime() + 5 * 60 * 1000);

      await service.closeForSession('session-1', endedAt);

      expect(update).toHaveBeenCalledWith({ id: 'log-1' }, { endedAt, durationSeconds: 300 });
    });

    it('only ever matches a log that is still open', async () => {
      const { service, findOne } = makeService();
      findOne.mockResolvedValue(log());

      await service.closeForSession('session-1', new Date());

      // Without the endedAt predicate a second close would overwrite the first,
      // moving a recorded end time later every time the session is touched.
      expect(findOne).toHaveBeenCalledWith({
        where: { sessionId: 'session-1', endedAt: IsNull() },
      });
    });

    it('is a no-op for a session with no open log', async () => {
      const { service, findOne, update } = makeService();
      findOne.mockResolvedValue(null);

      await service.closeForSession('session-1', new Date());

      expect(update).not.toHaveBeenCalled();
    });

    it('is a no-op for an ordinary, non-impersonation session', async () => {
      // Every logout runs through here, so the common case has to cost one
      // lookup and nothing else.
      const { service, update } = makeService();

      await service.closeForSession('plain-session', new Date());

      expect(update).not.toHaveBeenCalled();
    });

    it('never writes a negative duration when the clock moves backwards', async () => {
      const { service, findOne, update } = makeService();
      findOne.mockResolvedValue(log());

      await service.closeForSession('session-1', new Date(STARTED.getTime() - 60 * 1000));

      expect(update).toHaveBeenCalledWith(
        { id: 'log-1' },
        expect.objectContaining({ durationSeconds: 0 }),
      );
    });

    it('rounds sub-second precision rather than truncating', async () => {
      const { service, findOne, update } = makeService();
      findOne.mockResolvedValue(log());

      await service.closeForSession('session-1', new Date(STARTED.getTime() + 1600));

      expect(update).toHaveBeenCalledWith(
        { id: 'log-1' },
        expect.objectContaining({ durationSeconds: 2 }),
      );
    });
  });

  describe('closeForTargetUser', () => {
    it('closes every open log for the impersonated user, each with its own duration', async () => {
      const { service, find, update } = makeService();
      find.mockResolvedValue([
        log({ id: 'a', startedAt: new Date(STARTED.getTime()) }),
        log({ id: 'b', startedAt: new Date(STARTED.getTime() + 60 * 1000) }),
      ]);
      const endedAt = new Date(STARTED.getTime() + 120 * 1000);

      await service.closeForTargetUser('target-1', endedAt);

      expect(update).toHaveBeenCalledWith({ id: 'a' }, { endedAt, durationSeconds: 120 });
      expect(update).toHaveBeenCalledWith({ id: 'b' }, { endedAt, durationSeconds: 60 });
    });

    it('keys on the impersonated user, which is who the session belongs to', async () => {
      const { service, find } = makeService();

      await service.closeForTargetUser('target-1', new Date());

      expect(find).toHaveBeenCalledWith({
        where: { targetUserId: 'target-1', endedAt: IsNull() },
      });
    });

    it('does not issue an update when the user was never impersonated', async () => {
      // revokeAllUserSessions runs on every password change and deactivation,
      // so the overwhelmingly common case must stay a single read.
      const { service, update } = makeService();

      await service.closeForTargetUser('never-impersonated', new Date());

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('reconcileOpenLogs', () => {
    it('does not touch the database for an empty page', async () => {
      const { service, query } = makeService();

      await service.reconcileOpenLogs([], new Date());

      expect(query).not.toHaveBeenCalled();
    });

    it('passes the ids and the reference time through as bound parameters', async () => {
      const { service, query } = makeService();
      const now = new Date();

      await service.reconcileOpenLogs(['log-1', 'log-2'], now);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([['log-1', 'log-2'], now]);
      // The session row is the authority on when the session stopped being
      // usable; revoked_at wins over expires_at because a session can be
      // revoked before its cap.
      expect(sql).toContain('COALESCE(s."revoked_at", s."expires_at")');
      // Reconciliation must never reopen or move an already-recorded end.
      expect(sql).toContain('"ended_at" IS NULL');
    });
  });
});
