import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { ClockService } from '../../shared/clock/clock.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { CoachProfileService } from '../coaches/coach-profile.service';
import { CampSubmissionsService } from '../enrollment/camp-submissions.service';
import { ShareLinksService } from '../enrollment/share-links.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { StorageService } from '../storage/storage.service';
import { TrainersService } from '../trainers/trainers.service';
import { User } from '../users/entities/user.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { AUDIT_USER_DELETED, UserErasureService } from './user-erasure.service';

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'jane.doe@example.com',
    passwordHash: null,
    role: Role.PlayerParent,
    status: UserStatus.Active,
    emailVerified: true,
    emailVerifiedAt: null,
    mustSetPassword: false,
    isChildAccount: false,
    firstName: 'Jane',
    lastName: 'Doe',
    phone: '+1 555 000 1111',
    photoUrl: null,
    photoPublicId: null,
    tokenVersion: 0,
    lastLoginAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  } as User;
}

function actor(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'admin-1',
    role: Role.SuperAdmin,
    sessionId: 'session-1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: 'platform',
    impersonating: false,
    ...over,
  };
}

interface Mocks {
  service: UserErasureService;
  manager: EntityManager;
  now: Date;
  transaction: jest.Mock;
  findById: jest.Mock;
  findByIds: jest.Mock;
  usersAnonymize: jest.Mock;
  revokeAllUserSessions: jest.Mock;
  auditRecord: jest.Mock;
  scrubEmailFromMetadata: jest.Mock;
  childUserIdsByOwner: jest.Mock;
  findByOwner: jest.Mock;
  findByChildUserId: jest.Mock;
  anonymizeByOwner: jest.Mock;
  anonymizeByChildUserId: jest.Mock;
  scrubTargetEmail: jest.Mock;
  storageDelete: jest.Mock;
  coachAnonymizeByUserId: jest.Mock;
  trainerAnonymizeByUserId: jest.Mock;
  trainerFindByUserId: jest.Mock;
  scrubCampSubmissions: jest.Mock;
  deletionLogCreate: jest.Mock;
  deletionLogSave: jest.Mock;
}

/** A fresh set of collaborator mocks per test; nothing here is shared across cases. */
function build(): Mocks {
  const now = new Date('2026-01-15T12:00:00.000Z');

  const findById = jest.fn();
  const findByIds = jest.fn().mockResolvedValue([]);
  const usersAnonymize = jest.fn().mockResolvedValue(undefined);
  const usersService = {
    findById,
    findByIds,
    anonymize: usersAnonymize,
  } as unknown as UsersService;

  const revokeAllUserSessions = jest.fn().mockResolvedValue(undefined);
  const authService = { revokeAllUserSessions } as unknown as AuthService;

  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const scrubEmailFromMetadata = jest.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord, scrubEmailFromMetadata } as unknown as AuditService;

  const childUserIdsByOwner = jest.fn().mockResolvedValue([]);
  const findByOwner = jest.fn().mockResolvedValue([]);
  const findByChildUserId = jest.fn().mockResolvedValue(null);
  const anonymizeByOwner = jest.fn().mockResolvedValue(undefined);
  const anonymizeByChildUserId = jest.fn().mockResolvedValue(undefined);
  const playersService = {
    childUserIdsByOwner,
    findByOwner,
    findByChildUserId,
    anonymizeByOwner,
    anonymizeByChildUserId,
  } as unknown as PlayersService;

  const scrubTargetEmail = jest.fn().mockResolvedValue(undefined);
  const shareLinks = { scrubTargetEmail } as unknown as ShareLinksService;

  const scrubCampSubmissions = jest.fn().mockResolvedValue(undefined);
  const campSubmissions = {
    scrubByEmail: scrubCampSubmissions,
  } as unknown as CampSubmissionsService;

  const storageDelete = jest.fn().mockResolvedValue(undefined);
  const storage = { delete: storageDelete } as unknown as StorageService;

  const clock = { now: () => now } as unknown as ClockService;

  const coachAnonymizeByUserId = jest.fn().mockResolvedValue(undefined);
  const coachProfiles = {
    anonymizeByUserId: coachAnonymizeByUserId,
  } as unknown as CoachProfileService;

  const trainerAnonymizeByUserId = jest.fn().mockResolvedValue(undefined);
  const trainerFindByUserId = jest.fn().mockResolvedValue(null);
  const trainers = {
    anonymizeByUserId: trainerAnonymizeByUserId,
    findByUserId: trainerFindByUserId,
  } as unknown as TrainersService;

  const deletionLogCreate = jest.fn((x) => x);
  const deletionLogSave = jest.fn();
  const manager = {
    getRepository: jest.fn().mockReturnValue({ create: deletionLogCreate, save: deletionLogSave }),
  } as unknown as EntityManager;
  const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) => cb(manager));
  const dataSource = { transaction } as unknown as DataSource;

  const service = new UserErasureService(
    dataSource,
    usersService,
    authService,
    audit,
    playersService,
    shareLinks,
    storage,
    clock,
    coachProfiles,
    trainers,
    campSubmissions,
  );

  return {
    service,
    manager,
    now,
    transaction,
    findById,
    findByIds,
    usersAnonymize,
    revokeAllUserSessions,
    auditRecord,
    scrubEmailFromMetadata,
    childUserIdsByOwner,
    findByOwner,
    findByChildUserId,
    anonymizeByOwner,
    anonymizeByChildUserId,
    scrubTargetEmail,
    storageDelete,
    coachAnonymizeByUserId,
    trainerAnonymizeByUserId,
    trainerFindByUserId,
    scrubCampSubmissions,
    deletionLogCreate,
    deletionLogSave,
  };
}

describe('UserErasureService.deleteUser', () => {
  describe('guard clauses', () => {
    it('throws NotFoundException via requireUser when the target does not exist', async () => {
      const { service, findById, transaction } = build();
      findById.mockResolvedValue(null);

      await expect(service.deleteUser('missing', actor(), 'gdpr request')).rejects.toMatchObject({
        response: { errorCode: ErrorCode.NOT_FOUND },
      });
      await expect(service.deleteUser('missing', actor(), 'gdpr request')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses to delete a Super Admin account', async () => {
      const { service, findById, transaction } = build();
      findById.mockResolvedValue(makeUser({ role: Role.SuperAdmin }));

      await expect(service.deleteUser('user-1', actor(), 'gdpr request')).rejects.toMatchObject({
        response: { errorCode: ErrorCode.CANNOT_DELETE_SUPER_ADMIN },
      });
      await expect(service.deleteUser('user-1', actor(), 'gdpr request')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses a target that has already been deleted', async () => {
      const { service, findById, transaction } = build();
      findById.mockResolvedValue(makeUser({ status: UserStatus.Deleted }));

      await expect(service.deleteUser('user-1', actor(), 'gdpr request')).rejects.toMatchObject({
        response: { errorCode: ErrorCode.ACCOUNT_DELETED },
      });
      await expect(service.deleteUser('user-1', actor(), 'gdpr request')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('success cascade', () => {
    it('erases a childless, photo-less target with one deletion log row and no asset discard', async () => {
      const {
        service,
        manager,
        now,
        findById,
        deletionLogCreate,
        deletionLogSave,
        usersAnonymize,
        anonymizeByOwner,
        anonymizeByChildUserId,
        coachAnonymizeByUserId,
        auditRecord,
        revokeAllUserSessions,
        scrubTargetEmail,
        scrubEmailFromMetadata,
        storageDelete,
      } = build();
      const target = makeUser({ id: 'parent-1', email: 'parent@example.com' });
      const admin = actor();
      findById.mockResolvedValue(target);

      await service.deleteUser('parent-1', admin, 'gdpr request');

      expect(deletionLogSave).toHaveBeenCalledTimes(1);
      expect(deletionLogCreate).toHaveBeenCalledWith({
        userId: 'parent-1',
        originalEmail: 'parent@example.com',
        originalFirstName: target.firstName,
        originalLastName: target.lastName,
        originalPhone: target.phone,
        originalRole: target.role,
        deletedByUserId: admin.userId,
        reason: 'gdpr request',
        deletedAt: now,
        originalData: { childUserIds: [], hadPhoto: false },
      });

      expect(usersAnonymize).toHaveBeenCalledTimes(1);
      expect(usersAnonymize).toHaveBeenCalledWith('parent-1', manager);
      expect(anonymizeByOwner).toHaveBeenCalledTimes(1);
      expect(anonymizeByOwner).toHaveBeenCalledWith('parent-1', manager);
      expect(anonymizeByChildUserId).toHaveBeenCalledTimes(1);
      expect(anonymizeByChildUserId).toHaveBeenCalledWith('parent-1', manager);
      expect(coachAnonymizeByUserId).toHaveBeenCalledTimes(1);
      expect(coachAnonymizeByUserId).toHaveBeenCalledWith('parent-1', manager);

      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_USER_DELETED,
          actor: admin,
          targetUserId: 'parent-1',
          metadata: { reason: 'gdpr request', childAccountsAnonymized: 0 },
        }),
        manager,
      );

      expect(revokeAllUserSessions).toHaveBeenCalledTimes(1);
      expect(revokeAllUserSessions).toHaveBeenCalledWith('parent-1', 'deleted');

      expect(scrubTargetEmail).toHaveBeenCalledTimes(1);
      expect(scrubTargetEmail).toHaveBeenCalledWith('parent@example.com', manager);
      expect(scrubEmailFromMetadata).toHaveBeenCalledTimes(1);

      expect(storageDelete).not.toHaveBeenCalled();
    });

    it('discards the photo the target had when the call started, captured before anonymization', async () => {
      const { service, findById, storageDelete } = build();
      const target = makeUser({ id: 'parent-1', photoPublicId: 'avatars/parent-1' });
      findById.mockResolvedValue(target);

      await service.deleteUser('parent-1', actor(), 'gdpr request');

      // The mocked anonymize never mutates `target`, so this really only proves
      // deleteUser reads the photo id captured up front, not one re-fetched later.
      expect(storageDelete).toHaveBeenCalledTimes(1);
      expect(storageDelete).toHaveBeenCalledWith('avatars/parent-1');
    });

    it('excludes an already-deleted child login from the cascade entirely, but fully processes an active one', async () => {
      const {
        service,
        manager,
        findById,
        findByIds,
        childUserIdsByOwner,
        deletionLogCreate,
        deletionLogSave,
        usersAnonymize,
        anonymizeByOwner,
        anonymizeByChildUserId,
        coachAnonymizeByUserId,
        auditRecord,
        revokeAllUserSessions,
        scrubTargetEmail,
        scrubEmailFromMetadata,
      } = build();
      const target = makeUser({ id: 'parent-1', email: 'parent@example.com' });
      const activeChild = makeUser({
        id: 'child-active',
        email: 'active-child@example.com',
        status: UserStatus.Active,
      });
      const deletedChild = makeUser({
        id: 'child-deleted',
        email: 'deleted-child@example.com',
        status: UserStatus.Deleted,
      });
      findById.mockResolvedValue(target);
      childUserIdsByOwner.mockResolvedValue(['child-active', 'child-deleted']);
      findByIds.mockResolvedValue([activeChild, deletedChild]);

      await service.deleteUser('parent-1', actor(), 'gdpr request');

      expect(findByIds).toHaveBeenCalledWith(['child-active', 'child-deleted']);

      // One row for the target, one for the active child — none for the deleted one.
      expect(deletionLogSave).toHaveBeenCalledTimes(2);
      expect(deletionLogCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          userId: 'parent-1',
          originalData: { childUserIds: ['child-active'], hadPhoto: false },
        }),
      );
      expect(deletionLogCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          userId: 'child-active',
          originalData: { cascadedFromUserId: 'parent-1' },
        }),
      );

      expect(usersAnonymize).toHaveBeenCalledTimes(2);
      expect(usersAnonymize).toHaveBeenCalledWith('parent-1', manager);
      expect(usersAnonymize).toHaveBeenCalledWith('child-active', manager);
      expect(usersAnonymize).not.toHaveBeenCalledWith('child-deleted', manager);

      // Owner-wide profile anonymization only ever runs once, for the target.
      expect(anonymizeByOwner).toHaveBeenCalledTimes(1);
      expect(anonymizeByOwner).toHaveBeenCalledWith('parent-1', manager);

      expect(anonymizeByChildUserId).toHaveBeenCalledTimes(2);
      expect(anonymizeByChildUserId).toHaveBeenCalledWith('parent-1', manager);
      expect(anonymizeByChildUserId).toHaveBeenCalledWith('child-active', manager);

      // Coach-profile anonymization is per erasure, not per row in the cascade.
      expect(coachAnonymizeByUserId).toHaveBeenCalledTimes(1);
      expect(coachAnonymizeByUserId).toHaveBeenCalledWith('parent-1', manager);

      expect(revokeAllUserSessions).toHaveBeenCalledTimes(2);
      expect(revokeAllUserSessions).toHaveBeenCalledWith('parent-1', 'deleted');
      expect(revokeAllUserSessions).toHaveBeenCalledWith('child-active', 'parent-deleted');

      expect(scrubTargetEmail).toHaveBeenCalledTimes(2);
      expect(scrubTargetEmail).toHaveBeenCalledWith('parent@example.com', manager);
      expect(scrubTargetEmail).toHaveBeenCalledWith('active-child@example.com', manager);
      expect(scrubEmailFromMetadata).toHaveBeenCalledTimes(2);

      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { reason: 'gdpr request', childAccountsAnonymized: 1 },
        }),
        manager,
      );
    });

    it('sources the photo to discard from the child-login profile lookup, not the owner lookup, when the target is a child login', async () => {
      const { service, findById, findByOwner, findByChildUserId, storageDelete } = build();
      const target = makeUser({ id: 'child-1', isChildAccount: true, photoPublicId: null });
      findById.mockResolvedValue(target);
      findByOwner.mockResolvedValue([]);
      findByChildUserId.mockResolvedValue({
        photoPublicId: 'players/child-1-photo',
      } as PlayerProfile);

      await service.deleteUser('child-1', actor(), 'gdpr request');

      expect(findByOwner).toHaveBeenCalledWith('child-1');
      expect(findByChildUserId).toHaveBeenCalledWith('child-1');
      expect(storageDelete).toHaveBeenCalledWith('players/child-1-photo');
    });

    it('writes the compliance log before revoking sessions or discarding the photo', async () => {
      const order: string[] = [];
      const { service, findById, deletionLogSave, revokeAllUserSessions, storageDelete } = build();
      const target = makeUser({ id: 'parent-1', photoPublicId: 'avatars/parent-1' });
      findById.mockResolvedValue(target);
      deletionLogSave.mockImplementation(() => {
        order.push('log-write');
        return Promise.resolve(undefined);
      });
      revokeAllUserSessions.mockImplementation(() => {
        order.push('revoke');
        return Promise.resolve(undefined);
      });
      storageDelete.mockImplementation(() => {
        order.push('discard');
        return Promise.resolve(undefined);
      });

      await service.deleteUser('parent-1', actor(), 'gdpr request');

      // The compliance record must exist before the account is unrecoverably
      // scrubbed, so the log write cannot land after the session/asset cleanup.
      expect(order).toEqual(['log-write', 'revoke', 'discard']);
    });
  });

  describe('trainer organisation', () => {
    it('anonymises the trainer profile inside the same transaction', async () => {
      const { service, manager, findById, trainerAnonymizeByUserId } = build();
      findById.mockResolvedValue(makeUser({ id: 'trainer-1', role: Role.Trainer }));

      await service.deleteUser('trainer-1', actor(), 'gdpr request');

      expect(trainerAnonymizeByUserId).toHaveBeenCalledTimes(1);
      expect(trainerAnonymizeByUserId).toHaveBeenCalledWith('trainer-1', manager);
    });

    it('discards the org logo, read before anonymisation clears its handle', async () => {
      const { service, findById, trainerFindByUserId, trainerAnonymizeByUserId, storageDelete } =
        build();
      findById.mockResolvedValue(makeUser({ id: 'trainer-1', role: Role.Trainer }));
      trainerFindByUserId.mockResolvedValue({ id: 'org-1', logoPublicId: 'logos/abc' });

      const order: string[] = [];
      trainerAnonymizeByUserId.mockImplementation(() => {
        order.push('anonymize');
        return Promise.resolve(undefined);
      });
      storageDelete.mockImplementation(() => {
        order.push('discard');
        return Promise.resolve(undefined);
      });

      await service.deleteUser('trainer-1', actor(), 'gdpr request');

      expect(storageDelete).toHaveBeenCalledWith('logos/abc');
      // Reversed, the handle is already null and the image stays served.
      expect(order).toEqual(['anonymize', 'discard']);
    });

    it('discards nothing for a trainer who never uploaded a logo', async () => {
      const { service, findById, trainerFindByUserId, storageDelete } = build();
      findById.mockResolvedValue(makeUser({ id: 'trainer-1', role: Role.Trainer }));
      trainerFindByUserId.mockResolvedValue({ id: 'org-1', logoPublicId: null });

      await service.deleteUser('trainer-1', actor(), 'gdpr request');

      expect(storageDelete).not.toHaveBeenCalled();
    });

    it('is a harmless no-op for a user who runs no organisation', async () => {
      const { service, manager, findById, trainerAnonymizeByUserId, storageDelete } = build();
      findById.mockResolvedValue(makeUser({ id: 'parent-1' }));

      await service.deleteUser('parent-1', actor(), 'gdpr request');

      expect(trainerAnonymizeByUserId).toHaveBeenCalledWith('parent-1', manager);
      expect(storageDelete).not.toHaveBeenCalled();
    });
  });
});
