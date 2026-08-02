import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AdminService } from './admin.service';
import { AgeGateService } from '../../shared/registration/age-gate.service';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
import { CoachProfileService } from '../coaches/coach-profile.service';
import { MailService } from '../mail/mail.service';
import { PlayersService } from '../players/players.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import { UserErasureService } from './user-erasure.service';
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
    const dataSource = {
      transaction: async <T>(cb: (mgr: EntityManager) => Promise<T>): Promise<T> =>
        cb({} as EntityManager),
    } as unknown as DataSource;

    const ageGate = {} as unknown as AgeGateService;
    const coachProfiles = {} as unknown as CoachProfileService;
    const userErasure = {} as unknown as UserErasureService;

    const service = new AdminService(
      dataSource,
      usersService,
      trainersService,
      authService,
      mail,
      audit,
      playersService,
      ageGate,
      coachProfiles,
      userErasure,
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
    findByUserId: jest.Mock;
    trainerApplyProfileUpdate: jest.Mock;
    findSelfProfile: jest.Mock;
    playerApplyProfileUpdate: jest.Mock;
    adminUpdateProfile: jest.Mock;
    auditRecord: jest.Mock;
    assertOldEnough: jest.Mock;
  } => {
    const findById = jest.fn().mockResolvedValue({ id: 'target-1', role: targetRole } as User);
    const findByUserId = jest.fn();
    const trainerApplyProfileUpdate = jest.fn();
    const findSelfProfile = jest.fn();
    const playerApplyProfileUpdate = jest.fn();
    const adminUpdateProfile = jest.fn();
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const assertOldEnough = jest.fn();

    const service = new AdminService(
      {} as DataSource,
      { findById } as unknown as UsersService,
      {
        findByUserId,
        applyProfileUpdate: trainerApplyProfileUpdate,
      } as unknown as TrainersService,
      {} as AuthService,
      {} as MailService,
      { record: auditRecord } as unknown as AuditService,
      {
        findSelfProfile,
        applyProfileUpdate: playerApplyProfileUpdate,
      } as unknown as PlayersService,
      { assertOldEnoughForOwnAccount: assertOldEnough } as unknown as AgeGateService,
      { adminUpdateProfile } as unknown as CoachProfileService,
      {} as UserErasureService,
    );

    return {
      service,
      findById,
      findByUserId,
      trainerApplyProfileUpdate,
      findSelfProfile,
      playerApplyProfileUpdate,
      adminUpdateProfile,
      auditRecord,
      assertOldEnough,
    };
  };

  describe('updateTrainerProfile', () => {
    it('refuses a target that is not a Trainer', async () => {
      const { service } = makeService(Role.Coach);

      await expect(
        service.updateTrainerProfile('target-1', admin, { businessName: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.ROLE_MISMATCH } });
    });

    it('404s when the role check passes but no profile row exists', async () => {
      const { service, findByUserId } = makeService(Role.Trainer);
      findByUserId.mockResolvedValue(null);

      await expect(
        service.updateTrainerProfile('target-1', admin, { businessName: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND } });
    });

    it('resolves the profile then delegates the update + audit to TrainersService, as the admin actor', async () => {
      const { service, findByUserId, trainerApplyProfileUpdate } = makeService(Role.Trainer);
      const profile = {
        id: 'tp-1',
        userId: 'target-1',
        businessName: 'Hoops Academy',
        website: null,
        address: null,
        description: null,
      };
      findByUserId.mockResolvedValue(profile);
      trainerApplyProfileUpdate.mockResolvedValue({ ...profile, businessName: 'Elite Hoops' });

      const result = await service.updateTrainerProfile('target-1', admin, {
        businessName: 'Elite Hoops',
      });

      expect(result.businessName).toBe('Elite Hoops');
      expect(findByUserId).toHaveBeenCalledWith('target-1');
      expect(trainerApplyProfileUpdate).toHaveBeenCalledWith(
        profile,
        { businessName: 'Elite Hoops' },
        admin,
      );
    });
  });

  describe('updateCoachProfile', () => {
    it('refuses a target that is not a Coach', async () => {
      const { service } = makeService(Role.Trainer);

      await expect(
        service.updateCoachProfile('target-1', admin, { bio: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.ROLE_MISMATCH } });
    });

    it('delegates to CoachProfileService.adminUpdateProfile, which owns the lookup and audit', async () => {
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
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.ROLE_MISMATCH } });
    });

    it('404s a child login, which has no self profile of its own', async () => {
      const { service, findSelfProfile } = makeService(Role.PlayerParent);
      findSelfProfile.mockResolvedValue(null);

      await expect(
        service.updatePlayerProfile('target-1', admin, { school: 'Nope' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND } });
    });

    it('resolves the profile then delegates the update + audit to PlayersService, as the admin actor', async () => {
      const { service, findSelfProfile, playerApplyProfileUpdate } = makeService(Role.PlayerParent);
      const profile = {
        id: 'pp-1',
        ownerUserId: 'target-1',
        displayName: 'Sam',
        isChild: false,
        birthDate: '1994-03-22',
        gender: null,
        school: null,
        jerseyNumber: null,
        skillLevel: null,
      };
      findSelfProfile.mockResolvedValue(profile);
      playerApplyProfileUpdate.mockResolvedValue({ ...profile, school: 'Riverside High' });

      const result = await service.updatePlayerProfile('target-1', admin, {
        school: 'Riverside High',
      });

      expect(result.school).toBe('Riverside High');
      expect(findSelfProfile).toHaveBeenCalledWith('target-1');
      expect(playerApplyProfileUpdate).toHaveBeenCalledWith(
        profile,
        { school: 'Riverside High' },
        admin,
      );
    });

    it('puts a supplied birthDate through the same age floor as self-service', async () => {
      const { service, findSelfProfile, playerApplyProfileUpdate, assertOldEnough } = makeService(
        Role.PlayerParent,
      );
      findSelfProfile.mockResolvedValue({ id: 'pp-1', ownerUserId: 'target-1' });
      playerApplyProfileUpdate.mockResolvedValue({ id: 'pp-1', ownerUserId: 'target-1' });

      await service.updatePlayerProfile('target-1', admin, { birthDate: '1994-03-22' });

      expect(assertOldEnough).toHaveBeenCalledWith('1994-03-22');
    });

    it('does not write a birthDate the floor rejects', async () => {
      const { service, findSelfProfile, assertOldEnough } = makeService(Role.PlayerParent);
      assertOldEnough.mockImplementation(() => {
        throw new ForbiddenException({ errorCode: ErrorCode.UNDERAGE_SELF_REGISTRATION });
      });

      await expect(
        service.updatePlayerProfile('target-1', admin, { birthDate: '2020-01-01' }),
      ).rejects.toMatchObject({ response: { errorCode: ErrorCode.UNDERAGE_SELF_REGISTRATION } });
      expect(findSelfProfile).not.toHaveBeenCalled();
    });

    it('leaves the floor alone when birthDate is not part of the patch', async () => {
      const { service, findSelfProfile, playerApplyProfileUpdate, assertOldEnough } = makeService(
        Role.PlayerParent,
      );
      findSelfProfile.mockResolvedValue({ id: 'pp-1', ownerUserId: 'target-1' });
      playerApplyProfileUpdate.mockResolvedValue({ id: 'pp-1', ownerUserId: 'target-1' });

      await service.updatePlayerProfile('target-1', admin, { school: 'Riverside High' });

      expect(assertOldEnough).not.toHaveBeenCalled();
    });
  });
});
