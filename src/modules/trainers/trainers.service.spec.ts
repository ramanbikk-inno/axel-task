import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { OrgMembershipService } from '../org-membership/org-membership.service';
import { StorageService } from '../storage/storage.service';
import { TrainerProfile } from './entities/trainer-profile.entity';
import { AUDIT_TRAINER_PROFILE_UPDATED, TrainersService } from './trainers.service';

const ORG = 'trainer-org-1';
const ACTOR = { userId: 'user-1', sessionId: 'sess-1' } as Principal;

/** Only the fields these paths read are set. */
const trainerProfile = (over: Partial<TrainerProfile> = {}): TrainerProfile =>
  ({
    id: ORG,
    userId: 'user-1',
    businessName: 'Acme Hoops',
    website: null,
    address: null,
    description: null,
    ...over,
  }) as TrainerProfile;

interface Stub {
  service: TrainersService;
  findOne: jest.Mock;
  save: jest.Mock;
  isOrgMember: jest.Mock;
  auditRecord: jest.Mock;
}

function build(): Stub {
  const findOne = jest.fn().mockResolvedValue(null);
  const save = jest.fn().mockImplementation((p: TrainerProfile) => Promise.resolve(p));
  const isOrgMember = jest.fn().mockResolvedValue(false);
  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const service = new TrainersService(
    { findOne, save } as unknown as Repository<TrainerProfile>,
    { isOrgMember } as unknown as OrgMembershipService,
    {} as unknown as StorageService,
    { record: auditRecord } as unknown as AuditService,
  );
  return { service, findOne, save, isOrgMember, auditRecord };
}

describe('TrainersService.findAccessibleById', () => {
  it('returns the profile to an org member', async () => {
    const { service, findOne, isOrgMember } = build();
    const profile = trainerProfile();
    findOne.mockResolvedValue(profile);
    isOrgMember.mockResolvedValue(true);

    await expect(service.findAccessibleById(ACTOR, ORG)).resolves.toBe(profile);
    expect(isOrgMember).toHaveBeenCalledWith(ACTOR, ORG);
  });

  it('hides another org behind the same 404 a missing id gets', async () => {
    const { service, findOne, isOrgMember } = build();
    findOne.mockResolvedValue(trainerProfile());
    isOrgMember.mockResolvedValue(false);

    const nonMember = service.findAccessibleById(ACTOR, ORG);
    await expect(nonMember).rejects.toBeInstanceOf(NotFoundException);
    await expect(nonMember).rejects.toMatchObject({
      response: { errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND, message: 'Trainer not found.' },
    });
  });

  it('404s on an unknown id without asking about membership', async () => {
    const { service, isOrgMember } = build();

    await expect(service.findAccessibleById(ACTOR, ORG)).rejects.toBeInstanceOf(NotFoundException);
    expect(isOrgMember).not.toHaveBeenCalled();
  });
});

describe('TrainersService.requireOwnProfile', () => {
  it('returns the caller profile', async () => {
    const { service, findOne } = build();
    const profile = trainerProfile();
    findOne.mockResolvedValue(profile);

    await expect(service.requireOwnProfile('user-1')).resolves.toBe(profile);
    expect(findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('403s when the account has no trainer profile', async () => {
    const { service } = build();

    const missing = service.requireOwnProfile('user-1');
    await expect(missing).rejects.toBeInstanceOf(ForbiddenException);
    await expect(missing).rejects.toMatchObject({
      response: {
        errorCode: ErrorCode.TRAINER_PROFILE_NOT_FOUND,
        message: 'No trainer profile for this account.',
      },
    });
  });
});

describe('TrainersService.applyProfileUpdate', () => {
  it('writes only the keys the caller supplied and audits the changed ones', async () => {
    const { service, save, auditRecord } = build();

    await service.applyProfileUpdate(
      trainerProfile({ website: 'https://old.example' }),
      { businessName: 'New Name', address: null, description: undefined },
      ACTOR,
    );

    expect(save.mock.calls[0][0]).toMatchObject({
      businessName: 'New Name',
      address: null,
      website: 'https://old.example',
    });
    expect(auditRecord.mock.calls[0][0]).toEqual({
      action: AUDIT_TRAINER_PROFILE_UPDATED,
      actor: ACTOR,
      targetUserId: 'user-1',
      target: { type: 'TrainerProfile', id: ORG },
      metadata: { fields: ['businessName', 'address'] },
    });
  });

  it('runs the save and the audit row on a supplied transaction', async () => {
    const { service, save, auditRecord } = build();
    const txSave = jest.fn().mockImplementation((p: TrainerProfile) => Promise.resolve(p));
    const manager = {
      getRepository: jest.fn().mockReturnValue({ save: txSave }),
    } as unknown as EntityManager;

    await service.applyProfileUpdate(
      trainerProfile(),
      { businessName: 'New Name' },
      ACTOR,
      manager,
    );

    expect(txSave).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(auditRecord.mock.calls[0][1]).toBe(manager);
  });
});
