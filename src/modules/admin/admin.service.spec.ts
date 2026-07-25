import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AdminService } from './admin.service';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { AuthService } from '../auth/auth.service';
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
    const dataSource = {
      transaction: async <T>(cb: (mgr: EntityManager) => Promise<T>): Promise<T> =>
        cb({} as EntityManager),
    } as unknown as DataSource;

    const service = new AdminService(
      dataSource,
      usersService,
      trainersService,
      authService,
      mail,
      audit,
      playersService,
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
