import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AdminService } from './admin.service';
import { ClockService } from '../../shared/clock/clock.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
import { CoachesService } from '../coaches/coaches.service';
import { ShareLinksService } from '../enrollment/share-links.service';
import { MailService } from '../mail/mail.service';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { CreateTrainerDto } from './dto/create-trainer.dto';

describe('AdminService.createTrainer', () => {
  const makeService = (): {
    service: AdminService;
    findByEmail: jest.Mock;
    usersCreate: jest.Mock;
    trainersCreate: jest.Mock;
    createSetupToken: jest.Mock;
    sendTrainerInvite: jest.Mock;
    auditRecord: jest.Mock;
  } => {
    const findByEmail = jest.fn();
    const usersCreate = jest.fn();
    const trainersCreate = jest.fn();
    const createSetupToken = jest.fn().mockResolvedValue('plain-setup');
    const sendTrainerInvite = jest.fn().mockResolvedValue(undefined);
    const auditRecord = jest.fn().mockResolvedValue(undefined);

    const usersService = {
      findByEmail,
      create: usersCreate,
    } as unknown as UsersService;
    const trainersService = { create: trainersCreate } as unknown as TrainersService;
    const authService = { createSetupToken } as unknown as AuthService;
    const mail = { sendTrainerInviteEmail: sendTrainerInvite } as unknown as MailService;
    const audit = { record: auditRecord } as unknown as AuditService;
    const playersService = {} as unknown as PlayersService;
    const shareLinks = {
      scrubTargetEmail: jest.fn().mockResolvedValue(undefined),
    } as unknown as ShareLinksService;
    const dataSource = {
      transaction: async <T>(cb: (mgr: EntityManager) => Promise<T>): Promise<T> =>
        cb({} as EntityManager),
    } as unknown as DataSource;

    const storage = {
      upload: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as StorageService;
    const clock = { now: (): Date => new Date('2026-05-01T00:00:00.000Z') } as ClockService;
    const coachesService = {} as unknown as CoachesService;

    const service = new AdminService(
      dataSource,
      usersService,
      trainersService,
      authService,
      mail,
      audit,
      playersService,
      shareLinks,
      storage,
      clock,
      coachesService,
    );

    return {
      service,
      findByEmail,
      usersCreate,
      trainersCreate,
      createSetupToken,
      sendTrainerInvite,
      auditRecord,
    };
  };

  const dto: CreateTrainerDto = {
    email: 'new.trainer@example.com',
    firstName: 'New',
    lastName: 'Trainer',
    businessName: 'New Org',
  };

  /** A plain, non-impersonating Super Admin. */
  const admin = (over: Partial<Principal> = {}): Principal => ({
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
  });

  it('rejects creating a SuperAdmin with CANNOT_CREATE_SUPER_ADMIN (403)', async () => {
    const { service } = makeService();

    await expect(
      service.createTrainer({ ...dto, role: Role.SuperAdmin }, admin()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await service.createTrainer({ ...dto, role: Role.SuperAdmin }, admin());
      fail('expected throw');
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        errorCode: ErrorCode.CANNOT_CREATE_SUPER_ADMIN,
      });
    }
  });

  it('rejects a duplicate email with EMAIL_ALREADY_EXISTS (409)', async () => {
    const { service, findByEmail } = makeService();
    findByEmail.mockResolvedValue({ id: 'existing' } as User);

    try {
      await service.createTrainer(dto, admin());
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
    }
  });

  it('creates a Trainer user + trainer profile, mints a setup token and sends the invite', async () => {
    const {
      service,
      findByEmail,
      usersCreate,
      trainersCreate,
      createSetupToken,
      sendTrainerInvite,
      auditRecord,
    } = makeService();
    findByEmail.mockResolvedValue(null);
    usersCreate.mockResolvedValue({ id: 'user-1', email: dto.email } as User);
    trainersCreate.mockResolvedValue({ id: 'tp-1' });

    const result = await service.createTrainer(dto, admin());

    expect(usersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: dto.email,
        role: Role.Trainer,
        emailVerified: false,
        mustSetPassword: true,
        status: UserStatus.Active,
      }),
      expect.anything(),
    );
    expect(trainersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', businessName: 'New Org' }),
      expect.anything(),
    );
    expect(createSetupToken).toHaveBeenCalledWith('user-1', expect.anything());
    expect(sendTrainerInvite).toHaveBeenCalledWith(dto.email, 'New', 'plain-setup');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trainer.created',
        actor: expect.objectContaining({ userId: 'admin-1' }),
        targetUserId: 'user-1',
      }),
      expect.anything(),
    );
    expect(result).toEqual({ id: 'user-1', email: dto.email, role: Role.Trainer });
  });
});

describe('AdminService role-profile editing', () => {
  const admin: Principal = {
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
  };

  const makeService = (
    targetRole: Role,
  ): {
    service: AdminService;
    findById: jest.Mock;
    updateProfileByUserId: jest.Mock;
    updateSelfProfile: jest.Mock;
    adminUpdateProfile: jest.Mock;
    auditRecord: jest.Mock;
  } => {
    const findById = jest.fn().mockResolvedValue({ id: 'target-1', role: targetRole } as User);
    const updateProfileByUserId = jest.fn();
    const updateSelfProfile = jest.fn();
    const adminUpdateProfile = jest.fn();
    const auditRecord = jest.fn().mockResolvedValue(undefined);

    const service = new AdminService(
      {} as DataSource,
      { findById } as unknown as UsersService,
      { updateProfileByUserId } as unknown as TrainersService,
      {} as AuthService,
      {} as MailService,
      { record: auditRecord } as unknown as AuditService,
      { updateSelfProfile } as unknown as PlayersService,
      {} as ShareLinksService,
      {} as StorageService,
      {} as ClockService,
      { adminUpdateProfile } as unknown as CoachesService,
    );

    return {
      service,
      findById,
      updateProfileByUserId,
      updateSelfProfile,
      adminUpdateProfile,
      auditRecord,
    };
  };

  describe('updateTrainerProfile', () => {
    it('refuses a target that is not a Trainer', async () => {
      const { service } = makeService(Role.Coach);

      await expect(
        service.updateTrainerProfile('target-1', admin, { businessName: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.VALIDATION_ERROR } });
    });

    it('404s when the role check passes but no profile row exists', async () => {
      const { service, updateProfileByUserId } = makeService(Role.Trainer);
      updateProfileByUserId.mockResolvedValue(null);

      await expect(
        service.updateTrainerProfile('target-1', admin, { businessName: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND } });
    });

    it('updates the profile and audits it under the admin as actor', async () => {
      const { service, updateProfileByUserId, auditRecord } = makeService(Role.Trainer);
      updateProfileByUserId.mockResolvedValue({
        id: 'tp-1',
        userId: 'target-1',
        businessName: 'Elite Hoops',
        website: null,
        address: null,
        description: null,
      });

      const result = await service.updateTrainerProfile('target-1', admin, {
        businessName: 'Elite Hoops',
      });

      expect(result.businessName).toBe('Elite Hoops');
      expect(updateProfileByUserId).toHaveBeenCalledWith('target-1', {
        businessName: 'Elite Hoops',
      });
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'profile.trainer-updated',
          actor: expect.objectContaining({ userId: 'admin-1' }),
          targetUserId: 'target-1',
        }),
      );
    });
  });

  describe('updateCoachProfile', () => {
    it('refuses a target that is not a Coach', async () => {
      const { service } = makeService(Role.Trainer);

      await expect(
        service.updateCoachProfile('target-1', admin, { bio: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.VALIDATION_ERROR } });
    });

    it('delegates to CoachesService.adminUpdateProfile, which owns the lookup and audit', async () => {
      const { service, adminUpdateProfile } = makeService(Role.Coach);
      adminUpdateProfile.mockResolvedValue({ id: 'coach-1', bio: 'New bio' });

      const result = await service.updateCoachProfile('target-1', admin, { bio: 'New bio' });

      expect(adminUpdateProfile).toHaveBeenCalledWith('target-1', admin, { bio: 'New bio' });
      expect(result).toEqual({ id: 'coach-1', bio: 'New bio' });
    });
  });

  describe('updatePlayerProfile', () => {
    it('refuses a target that is not a PlayerParent', async () => {
      const { service } = makeService(Role.Trainer);

      await expect(
        service.updatePlayerProfile('target-1', admin, { school: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.VALIDATION_ERROR } });
    });

    it('404s a child login, which has no self profile of its own', async () => {
      const { service, updateSelfProfile } = makeService(Role.PlayerParent);
      updateSelfProfile.mockResolvedValue(null);

      await expect(
        service.updatePlayerProfile('target-1', admin, { school: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND } });
    });

    it('updates the profile and audits it under the admin as actor', async () => {
      const { service, updateSelfProfile, auditRecord } = makeService(Role.PlayerParent);
      updateSelfProfile.mockResolvedValue({
        id: 'pp-1',
        ownerUserId: 'target-1',
        displayName: 'Sam',
        isChild: false,
        birthDate: '1994-03-22',
        gender: null,
        school: 'Riverside High',
        jerseyNumber: null,
        skillLevel: null,
      });

      const result = await service.updatePlayerProfile('target-1', admin, {
        school: 'Riverside High',
      });

      expect(result.school).toBe('Riverside High');
      expect(updateSelfProfile).toHaveBeenCalledWith('target-1', { school: 'Riverside High' });
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'profile.player-updated',
          actor: expect.objectContaining({ userId: 'admin-1' }),
          targetUserId: 'target-1',
        }),
      );
    });
  });
});
