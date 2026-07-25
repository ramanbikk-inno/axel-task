import { ClockService } from '../../shared/clock/clock.service';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { AuditService } from './audit.service';
import { AuditLog } from './entities/audit-log.entity';

const NOW = new Date('2026-05-01T10:00:00.000Z');

class FixedClock {
  now(): Date {
    return new Date(NOW.getTime());
  }
}

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    role: Role.PlayerParent,
    sessionId: 'session-1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: 'trainer',
    impersonating: false,
    ...over,
  };
}

describe('AuditService attribution', () => {
  let saved: Partial<AuditLog>;
  let service: AuditService;

  beforeEach(() => {
    saved = {};
    const repo = {
      create: (row: Partial<AuditLog>): Partial<AuditLog> => row,
      save: async (row: Partial<AuditLog>): Promise<Partial<AuditLog>> => {
        saved = row;
        return row;
      },
    };
    service = new AuditService(repo as never, new FixedClock() as unknown as ClockService);
  });

  it('records an ordinary action with no impersonation columns set', async () => {
    await service.record({ action: 'user.updated', actor: principal(), targetUserId: 'user-2' });

    expect(saved).toMatchObject({
      action: 'user.updated',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
      onBehalfOfAdminId: null,
      impersonationSessionId: null,
      createdAt: NOW,
    });
  });

  it('attributes an action taken during impersonation to the admin behind it', async () => {
    await service.record({
      action: 'user.updated',
      actor: principal({
        userId: 'victim-1',
        sessionId: 'imp-session-9',
        impersonating: true,
        actor: { userId: 'admin-7' },
      }),
      targetUserId: 'victim-1',
    });

    // actorUserId stays the impersonated user — that is who the request was
    // made as — while the admin is recorded separately, so a reviewer can ask
    // either question of the same row.
    expect(saved.actorUserId).toBe('victim-1');
    expect(saved.onBehalfOfAdminId).toBe('admin-7');
    expect(saved.impersonationSessionId).toBe('imp-session-9');
  });

  it('ignores an impersonating flag with no actor attached', async () => {
    // Defensive: the pair is what makes an impersonation, and half of it must
    // not produce a row claiming an admin id it does not have.
    await service.record({
      action: 'user.updated',
      actor: principal({ impersonating: true }),
    });

    expect(saved.onBehalfOfAdminId).toBeNull();
    expect(saved.impersonationSessionId).toBeNull();
  });

  it('records a non-user target as a type/id pair', async () => {
    await service.record({
      action: 'coach.offboarded',
      actor: principal({ role: Role.Trainer }),
      target: { type: 'CoachProfile', id: 'cp-3' },
    });

    expect(saved).toMatchObject({ targetType: 'CoachProfile', targetId: 'cp-3' });
    expect(saved.targetUserId).toBeNull();
  });

  it('records a system action with no actor at all', async () => {
    await service.recordSystemAction({ action: 'seed.super-admin' });

    expect(saved.actorUserId).toBeNull();
    expect(saved.onBehalfOfAdminId).toBeNull();
  });
});
