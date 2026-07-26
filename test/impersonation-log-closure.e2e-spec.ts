import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { bootstrapE2E, E2EContext } from './setup-e2e';
import { createUser } from './helpers/user.factory';
import { IMPERSONATION_TTL_MS } from '../src/modules/impersonation/impersonation.service';
import { ImpersonationLog } from '../src/modules/impersonation/entities/impersonation-log.entity';
import { Role } from '../src/modules/users/entities/user.enums';

/**
 * Only `/impersonation/exit` ever wrote an end time. Every other way a session
 * ends — the one-hour cap, logging out of it, and the bulk revocation behind
 * deactivation, erasure and password change — left the row open forever, so the
 * compliance report reported neither an end nor a duration for it.
 */
describe('Impersonation log closure (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  const START = new Date('2026-03-01T09:00:00.000Z');

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    app = ctx.app;
  }, 180000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    ctx.clock.set(START);
  });

  const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const adminToken = async (): Promise<string> => {
    const sa = await ctx.seedSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: sa.email, password: sa.password })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** Start an impersonation of a fresh trainer and return both sides' tokens. */
  const impersonate = async (
    email: string,
  ): Promise<{ admin: string; session: string; refresh: string; targetId: string }> => {
    const admin = await adminToken();
    const target = await createUser(ctx.dataSource, { role: Role.Trainer, email });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/users/${target.id}/impersonate`)
      .set(auth(admin))
      .send({ reason: 'Support ticket 42.' })
      .expect(200);

    return {
      admin,
      session: res.body.accessToken as string,
      refresh: res.body.refreshToken as string,
      targetId: target.id,
    };
  };

  const openLogs = (): Promise<ImpersonationLog[]> =>
    ctx.dataSource.getRepository(ImpersonationLog).find();

  const history = async (admin: string): Promise<Record<string, unknown>[]> => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/users/impersonation/history')
      .set(auth(admin))
      .expect(200);
    return res.body.items as Record<string, unknown>[];
  };

  it('closes the log when the admin logs out of the impersonation session', async () => {
    const { refresh } = await impersonate('logout-target@example.com');

    ctx.clock.advance(5 * 60 * 1000);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refresh })
      .expect(204);

    const [log] = await openLogs();
    expect(log.endedAt).not.toBeNull();
    expect(log.durationSeconds).toBe(300);
  });

  it('closes the log when the target is deactivated out from under the session', async () => {
    const { admin, targetId } = await impersonate('revoked-target@example.com');

    ctx.clock.advance(2 * 60 * 1000);
    await request(app.getHttpServer())
      .post(`/api/v1/users/${targetId}/deactivate`)
      .set(auth(admin))
      .send({ reason: 'Abuse report.' })
      .expect(200);

    const [log] = await openLogs();
    expect(log.endedAt).not.toBeNull();
    expect(log.durationSeconds).toBe(120);
  });

  it('reports an end and duration for a session that simply hit the one-hour cap', async () => {
    // Nothing runs at expiry — it is enforced lazily on the next request — so
    // this is the case a write-time hook can never cover.
    const { admin } = await impersonate('expired-target@example.com');

    const before = await openLogs();
    expect(before[0].endedAt).toBeNull();

    ctx.clock.advance(IMPERSONATION_TTL_MS + 60 * 1000);

    const items = await history(admin);
    expect(items).toHaveLength(1);
    expect(items[0].endedAt).not.toBeNull();
    // Capped at the expiry, not at "now": the session stopped being usable when
    // it expired, not when someone got round to reading the report.
    expect(items[0].durationSeconds).toBe(IMPERSONATION_TTL_MS / 1000);
  });

  it('leaves a live session open, so an in-progress impersonation is visible as such', async () => {
    const { admin } = await impersonate('live-target@example.com');

    ctx.clock.advance(10 * 60 * 1000);

    const items = await history(admin);
    expect(items[0].endedAt).toBeNull();
    expect(items[0].durationSeconds).toBeNull();
  });

  it('still records exit the same way, and does not double-close', async () => {
    const { admin, session, refresh } = await impersonate('exit-target@example.com');

    ctx.clock.advance(60 * 1000);
    await request(app.getHttpServer())
      .post('/api/v1/users/impersonation/exit')
      .set(auth(session))
      .expect(200);

    const afterExit = await openLogs();
    expect(afterExit[0].durationSeconds).toBe(60);

    // A later logout of the same session must not overwrite the recorded end.
    ctx.clock.advance(60 * 1000);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refresh })
      .expect(204);

    const afterLogout = await openLogs();
    expect(afterLogout[0].durationSeconds).toBe(60);
    expect(afterLogout[0].endedAt).toEqual(afterExit[0].endedAt);
    expect(await history(admin)).toHaveLength(1);
  });

  it('records the coach availability write an impersonated admin makes', async () => {
    // The attribution mechanism existed but availability/ never emitted a row,
    // so this write produced no audit entry and no impersonation-history action.
    const admin = await adminToken();
    const parent = await ctx.registerVerifiedPlayer({ email: 'imp-parent@example.com' });

    const started = await request(app.getHttpServer())
      .post(`/api/v1/users/${parent.userId}/impersonate`)
      .set(auth(admin))
      .send({ reason: 'Reproducing a scheduling complaint.' })
      .expect(200);
    const session = started.body.accessToken as string;

    // A freshly registered account has no trainee profile until it joins a
    // trainer, so give the admin something to write availability against.
    const child = await request(app.getHttpServer())
      .post('/api/v1/players/children')
      .set(auth(session))
      .send({ displayName: 'Alex', birthDate: '2014-08-01', gender: 'female' })
      .expect(201);
    const profileId = child.body.id as string;

    await request(app.getHttpServer())
      .put(`/api/v1/players/${profileId}/availability`)
      .set(auth(session))
      .send({ slots: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }] })
      .expect(200);

    const items = await history(admin);
    const actions = items[0].actions as { action: string }[];
    expect(actions.map((a) => a.action)).toContain('availability.player-set');
  });
});
