import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { OrgMembershipService } from '../org-membership/org-membership.service';
import { TrainerProfile } from '../trainers/entities/trainer-profile.entity';
import { TrainersService } from '../trainers/trainers.service';
import { Role } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AUDIT_COACH_OFFBOARDED, AUDIT_COACH_PROFILE_UPDATED } from './coach-audit-actions';
import { CoachProfileService } from './coach-profile.service';
import { CoachProfile, CoachStatus } from './entities/coach-profile.entity';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    role: Role.Coach,
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

function coachRow(over: Partial<CoachProfile> = {}): CoachProfile {
  return {
    id: 'coach-1',
    userId: 'user-1',
    trainerProfileId: 'trainer-1',
    bio: null,
    credentials: null,
    certifications: null,
    publicVisible: false,
    status: CoachStatus.Active,
    joinedAt: new Date('2024-01-01T00:00:00Z'),
    endedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...over,
  } as CoachProfile;
}

function userRow(over: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'coach@example.com',
    firstName: 'Cody',
    lastName: 'Coach',
    ...over,
  } as User;
}

interface Mocks {
  service: CoachProfileService;
  coaches: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  trainersService: { requireOwnProfile: jest.Mock };
  orgMembership: { isOrgMember: jest.Mock };
  usersService: { findByIds: jest.Mock };
  authService: { revokeAllUserSessions: jest.Mock };
  audit: { record: jest.Mock };
  clock: { now: jest.Mock };
}

function build(): Mocks {
  const findOne = jest.fn();
  const find = jest.fn();
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const save = jest.fn().mockImplementation((p: CoachProfile) => Promise.resolve(p));
  const create = jest.fn().mockImplementation((p: Partial<CoachProfile>) => p);
  const coaches = { findOne, find, update, save, create } as unknown as Repository<CoachProfile>;

  const requireOwnProfile = jest.fn();
  const trainersService = { requireOwnProfile } as unknown as TrainersService;

  const isOrgMember = jest.fn();
  const orgMembership = { isOrgMember } as unknown as OrgMembershipService;

  const findByIds = jest.fn().mockResolvedValue([]);
  const usersService = { findByIds } as unknown as UsersService;

  const revokeAllUserSessions = jest.fn().mockResolvedValue(undefined);
  const authService = { revokeAllUserSessions } as unknown as AuthService;

  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuditService;

  const now = jest.fn().mockReturnValue(new Date('2026-07-29T12:00:00Z'));
  const clock = { now } as unknown as ClockService;

  const service = new CoachProfileService(
    coaches,
    trainersService,
    orgMembership,
    usersService,
    authService,
    audit,
    clock,
  );

  return {
    service,
    coaches: { findOne, find, update, save, create },
    trainersService: { requireOwnProfile },
    orgMembership: { isOrgMember },
    usersService: { findByIds },
    authService: { revokeAllUserSessions },
    audit: { record },
    clock: { now },
  };
}

describe('CoachProfileService.offboardCoach', () => {
  const ACTOR = principal({ userId: 'trainer-user-1', role: Role.Trainer, coachProfileId: null });

  it("resolves the caller's own trainer profile before touching the coach table", async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockRejectedValue(new ForbiddenException());

    await expect(m.service.offboardCoach(ACTOR, 'coach-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(m.trainersService.requireOwnProfile).toHaveBeenCalledWith('trainer-user-1');
    expect(m.coaches.findOne).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the id AND the caller's own trainerProfileId — the tenancy boundary", async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    m.coaches.findOne.mockResolvedValue(null);

    await expect(m.service.offboardCoach(ACTOR, 'coach-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.coaches.findOne).toHaveBeenCalledWith({
      where: { id: 'coach-1', trainerProfileId: 'trainer-1' },
    });
  });

  it('throws NotFoundException/COACH_PROFILE_NOT_FOUND when no row matches that scope', async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    m.coaches.findOne.mockResolvedValue(null);

    await expect(m.service.offboardCoach(ACTOR, 'coach-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND },
    });
  });

  it('throws ConflictException/COACH_ALREADY_INACTIVE when the coach is already off-boarded', async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    m.coaches.findOne.mockResolvedValue(coachRow({ status: CoachStatus.Inactive }));

    await expect(m.service.offboardCoach(ACTOR, 'coach-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.COACH_ALREADY_INACTIVE },
    });
    expect(m.coaches.update).not.toHaveBeenCalled();
  });

  it("marks the row Inactive, revokes the coach's sessions and audits the off-boarding", async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    const row = coachRow();
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);
    const now = new Date('2026-07-29T12:00:00Z');
    m.clock.now.mockReturnValue(now);

    const result = await m.service.offboardCoach(ACTOR, 'coach-1');

    expect(m.coaches.update).toHaveBeenCalledWith(
      { id: 'coach-1' },
      { status: CoachStatus.Inactive, endedAt: now },
    );
    // Tenancy for session revocation comes from this row, not the caller's org.
    expect(m.authService.revokeAllUserSessions).toHaveBeenCalledWith('user-1', 'coach-offboarded');
    expect(m.audit.record).toHaveBeenCalledWith({
      action: AUDIT_COACH_OFFBOARDED,
      actor: ACTOR,
      targetUserId: 'user-1',
      target: { type: 'CoachProfile', id: 'coach-1' },
    });
    expect(result.status).toBe(CoachStatus.Inactive);
    expect(result.endedAt).toBe(now);
  });
});

describe('CoachProfileService.getOwnProfile', () => {
  it('throws ForbiddenException/COACH_PROFILE_NOT_FOUND when the principal has no coach profile', async () => {
    const m = build();

    await expect(
      m.service.getOwnProfile(principal({ coachProfileId: null })),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND } });
    await expect(
      m.service.getOwnProfile(principal({ coachProfileId: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.coaches.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException/COACH_PROFILE_NOT_FOUND when the referenced row is missing', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(null);

    await expect(
      m.service.getOwnProfile(principal({ coachProfileId: 'coach-1' })),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND } });
    await expect(
      m.service.getOwnProfile(principal({ coachProfileId: 'coach-1' })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.coaches.findOne).toHaveBeenCalledWith({ where: { id: 'coach-1' } });
  });

  it("returns the caller's own profile view", async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(coachRow({ id: 'coach-1' }));
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    const result = await m.service.getOwnProfile(principal({ coachProfileId: 'coach-1' }));

    expect(result.id).toBe('coach-1');
  });
});

describe('CoachProfileService.updateOwnProfile', () => {
  it('throws ForbiddenException/COACH_PROFILE_NOT_FOUND with no active coach profile, before any write', async () => {
    const m = build();

    await expect(
      m.service.updateOwnProfile(principal({ coachProfileId: null }), { bio: 'New bio' }),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND } });
    expect(m.coaches.save).not.toHaveBeenCalled();
  });

  it('writes only the keys the caller supplied', async () => {
    const m = build();
    const row = coachRow({ bio: 'Old bio', credentials: 'Old creds' });
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    await m.service.updateOwnProfile(principal({ coachProfileId: 'coach-1' }), { bio: 'New bio' });

    expect(m.coaches.save.mock.calls[0][0]).toMatchObject({
      bio: 'New bio',
      credentials: 'Old creds',
    });
  });

  it('leaves an absent key out of the write entirely', async () => {
    const m = build();
    const row = coachRow({ bio: 'Old bio', credentials: 'Old creds' });
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    await m.service.updateOwnProfile(principal({ coachProfileId: 'coach-1' }), {
      bio: undefined,
      credentials: 'New creds',
    });

    expect(m.coaches.save.mock.calls[0][0]).toMatchObject({
      bio: 'Old bio',
      credentials: 'New creds',
    });
  });

  it('clears a nullable field on an explicit null', async () => {
    const m = build();
    const row = coachRow({ bio: 'Old bio' });
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    await m.service.updateOwnProfile(principal({ coachProfileId: 'coach-1' }), { bio: null });

    expect(m.coaches.save.mock.calls[0][0]).toMatchObject({ bio: null });
  });

  it('writes publicVisible only when the caller explicitly supplied it', async () => {
    const m = build();
    const row = coachRow({ publicVisible: false });
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    await m.service.updateOwnProfile(principal({ coachProfileId: 'coach-1' }), {
      publicVisible: true,
    });

    expect(m.coaches.save.mock.calls[0][0]).toMatchObject({ publicVisible: true });
  });

  it('records the update naming only the changed fields', async () => {
    const m = build();
    const row = coachRow();
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow()]);
    const actor = principal({ coachProfileId: 'coach-1' });

    await m.service.updateOwnProfile(actor, { bio: 'New bio', credentials: undefined });

    expect(m.audit.record).toHaveBeenCalledWith({
      action: AUDIT_COACH_PROFILE_UPDATED,
      actor,
      targetUserId: row.userId,
      target: { type: 'CoachProfile', id: row.id },
      metadata: { fields: ['bio'] },
    });
  });
});

describe('CoachProfileService.adminUpdateProfile', () => {
  const admin = principal({ userId: 'admin-1', role: Role.SuperAdmin, scope: 'platform' });

  it('throws NotFoundException/COACH_PROFILE_NOT_FOUND when there is no Active row for the target user', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(null);

    await expect(
      m.service.adminUpdateProfile('target-user-1', admin, { bio: 'New bio' }),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.COACH_PROFILE_NOT_FOUND } });
    // Active-only in the where clause: an Inactive row for the same user must not be edited.
    expect(m.coaches.findOne).toHaveBeenCalledWith({
      where: { userId: 'target-user-1', status: CoachStatus.Active },
    });
  });

  it("applies the patch and audits the admin as actor, targeting the coach's own userId", async () => {
    const m = build();
    const row = coachRow({ userId: 'target-user-1' });
    m.coaches.findOne.mockResolvedValue(row);
    m.usersService.findByIds.mockResolvedValue([userRow({ id: 'target-user-1' })]);

    await m.service.adminUpdateProfile('target-user-1', admin, { bio: 'New bio' });

    expect(m.coaches.save.mock.calls[0][0]).toMatchObject({ bio: 'New bio' });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_COACH_PROFILE_UPDATED,
        actor: admin,
        targetUserId: 'target-user-1',
      }),
    );
  });
});

describe('CoachProfileService.findActiveByUserId', () => {
  it('returns null when there is no Active row for the user', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(null);

    await expect(m.service.findActiveByUserId('user-1')).resolves.toBeNull();
    expect(m.coaches.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: CoachStatus.Active },
    });
  });

  it('returns the view when an Active row exists', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(coachRow());
    m.usersService.findByIds.mockResolvedValue([userRow()]);

    const result = await m.service.findActiveByUserId('user-1');

    expect(result?.id).toBe('coach-1');
  });
});

describe('CoachProfileService.listCoaches', () => {
  it("filters to the caller's own org and Active status by default", async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    m.coaches.find.mockResolvedValue([]);

    await m.service.listCoaches(principal({ userId: 'trainer-user-1' }));

    expect(m.coaches.find).toHaveBeenCalledWith({
      where: { trainerProfileId: 'trainer-1', status: CoachStatus.Active },
      order: { joinedAt: 'DESC' },
    });
  });

  it('drops the status filter when includeInactive is true', async () => {
    const m = build();
    m.trainersService.requireOwnProfile.mockResolvedValue({ id: 'trainer-1' } as TrainerProfile);
    m.coaches.find.mockResolvedValue([]);

    await m.service.listCoaches(principal({ userId: 'trainer-user-1' }), true);

    expect(m.coaches.find).toHaveBeenCalledWith({
      where: { trainerProfileId: 'trainer-1' },
      order: { joinedAt: 'DESC' },
    });
  });
});

describe('CoachProfileService.listPublicCoaches', () => {
  it('throws NotFoundException/NOT_FOUND when the caller is not an org member', async () => {
    const m = build();
    m.orgMembership.isOrgMember.mockResolvedValue(false);

    await expect(m.service.listPublicCoaches(principal(), 'trainer-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.NOT_FOUND },
    });
    await expect(m.service.listPublicCoaches(principal(), 'trainer-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.coaches.find).not.toHaveBeenCalled();
  });

  it('queries only public, Active rows for the requested org', async () => {
    const m = build();
    m.orgMembership.isOrgMember.mockResolvedValue(true);
    m.coaches.find.mockResolvedValue([]);

    await m.service.listPublicCoaches(principal(), 'trainer-1');

    expect(m.coaches.find).toHaveBeenCalledWith({
      where: { trainerProfileId: 'trainer-1', status: CoachStatus.Active, publicVisible: true },
      order: { joinedAt: 'ASC' },
    });
  });

  it('returns only the public-safe fields — never email, status, employment dates or userId', async () => {
    const m = build();
    m.orgMembership.isOrgMember.mockResolvedValue(true);
    m.coaches.find.mockResolvedValue([
      coachRow({
        id: 'coach-1',
        bio: 'Great coach',
        credentials: 'UEFA A',
        certifications: 'First Aid',
      }),
    ]);
    m.usersService.findByIds.mockResolvedValue([
      userRow({ id: 'user-1', email: 'secret@example.com' }),
    ]);

    const [view] = await m.service.listPublicCoaches(principal(), 'trainer-1');

    expect(view).toEqual({
      id: 'coach-1',
      firstName: 'Cody',
      lastName: 'Coach',
      bio: 'Great coach',
      credentials: 'UEFA A',
      certifications: 'First Aid',
    });
    // Security boundary: PublicCoachView must never leak email or employment metadata.
    expect(view).not.toHaveProperty('email');
    expect(view).not.toHaveProperty('status');
    expect(view).not.toHaveProperty('joinedAt');
    expect(view).not.toHaveProperty('endedAt');
    expect(view).not.toHaveProperty('userId');
  });
});

describe('CoachProfileService.anonymizeByUserId', () => {
  it('clears PII on every row for the user, then off-boards only the Active one, in two separate writes', async () => {
    const m = build();
    const now = new Date('2026-07-29T12:00:00Z');
    m.clock.now.mockReturnValue(now);

    await m.service.anonymizeByUserId('user-1');

    expect(m.coaches.update).toHaveBeenCalledTimes(2);
    expect(m.coaches.update).toHaveBeenNthCalledWith(
      1,
      { userId: 'user-1' },
      { bio: null, credentials: null, certifications: null, publicVisible: false },
    );
    expect(m.coaches.update).toHaveBeenNthCalledWith(
      2,
      { userId: 'user-1', status: CoachStatus.Active },
      { status: CoachStatus.Inactive, endedAt: now },
    );
  });

  it('runs both writes against a supplied transaction repo, not the injected one', async () => {
    const m = build();
    const now = new Date('2026-07-29T12:00:00Z');
    m.clock.now.mockReturnValue(now);
    const txUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    const getRepository = jest.fn().mockReturnValue({ update: txUpdate });
    const manager = { getRepository } as unknown as EntityManager;

    await m.service.anonymizeByUserId('user-1', manager);

    expect(getRepository).toHaveBeenCalledWith(CoachProfile);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(m.coaches.update).not.toHaveBeenCalled();
  });
});

describe('CoachProfileService.assertNotActiveElsewhere', () => {
  it('resolves when there is no Active row anywhere for the user', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(null);

    await expect(
      m.service.assertNotActiveElsewhere('user-1', 'trainer-1'),
    ).resolves.toBeUndefined();
    expect(m.coaches.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: CoachStatus.Active },
    });
  });

  // NB: reuses EMAIL_ALREADY_EXISTS for "already active in your own org" — an odd
  // errorCode choice, flagged separately, but this is the real current behavior.
  it('throws ConflictException/EMAIL_ALREADY_EXISTS when already Active for the same trainer', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(coachRow({ trainerProfileId: 'trainer-1' }));

    await expect(m.service.assertNotActiveElsewhere('user-1', 'trainer-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.EMAIL_ALREADY_EXISTS },
    });
    await expect(m.service.assertNotActiveElsewhere('user-1', 'trainer-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws ConflictException/COACH_ACTIVE_ELSEWHERE when Active for a different trainer', async () => {
    const m = build();
    m.coaches.findOne.mockResolvedValue(coachRow({ trainerProfileId: 'other-trainer' }));

    await expect(m.service.assertNotActiveElsewhere('user-1', 'trainer-1')).rejects.toMatchObject({
      response: { errorCode: ErrorCode.COACH_ACTIVE_ELSEWHERE },
    });
  });

  it('runs the lookup against a supplied transaction repo', async () => {
    const m = build();
    const findOne = jest.fn().mockResolvedValue(null);
    const getRepository = jest.fn().mockReturnValue({ findOne });
    const manager = { getRepository } as unknown as EntityManager;

    await m.service.assertNotActiveElsewhere('user-1', 'trainer-1', manager);

    expect(getRepository).toHaveBeenCalledWith(CoachProfile);
    expect(findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: CoachStatus.Active },
    });
    expect(m.coaches.findOne).not.toHaveBeenCalled();
  });
});

describe('CoachProfileService.startEngagement', () => {
  it('creates and saves an Active row with joinedAt from the clock and no endedAt', async () => {
    const m = build();
    const now = new Date('2026-07-29T12:00:00Z');
    m.clock.now.mockReturnValue(now);

    const result = await m.service.startEngagement('user-1', 'trainer-1');

    expect(m.coaches.create).toHaveBeenCalledWith({
      userId: 'user-1',
      trainerProfileId: 'trainer-1',
      publicVisible: false,
      status: CoachStatus.Active,
      joinedAt: now,
      endedAt: null,
    });
    expect(m.coaches.save).toHaveBeenCalledWith(result);
  });

  it('runs on a supplied transaction repo, not the injected one', async () => {
    const m = build();
    const now = new Date('2026-07-29T12:00:00Z');
    m.clock.now.mockReturnValue(now);
    const create = jest.fn().mockImplementation((p: Partial<CoachProfile>) => p);
    const save = jest.fn().mockImplementation((p: CoachProfile) => Promise.resolve(p));
    const getRepository = jest.fn().mockReturnValue({ create, save });
    const manager = { getRepository } as unknown as EntityManager;

    await m.service.startEngagement('user-1', 'trainer-1', manager);

    expect(getRepository).toHaveBeenCalledWith(CoachProfile);
    expect(create).toHaveBeenCalledTimes(1);
    expect(m.coaches.create).not.toHaveBeenCalled();
    expect(m.coaches.save).not.toHaveBeenCalled();
  });
});
