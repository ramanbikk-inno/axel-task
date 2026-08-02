import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PasswordService } from '../../shared/crypto/password.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { Role, UserStatus } from '../users/entities/user.enums';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  AUDIT_CHILD_LOGIN_CREATED,
  AUDIT_CHILD_LOGIN_REVOKED,
  ChildAccountService,
} from './child-account.service';

const ACTOR: Principal = {
  userId: 'parent-1',
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
};

const childProfile = (over: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    id: 'profile-1',
    ownerUserId: 'parent-1',
    displayName: 'Maya',
    isChild: true,
    childUserId: null,
    ...over,
  }) as PlayerProfile;

interface Stub {
  service: ChildAccountService;
  findByEmail: jest.Mock;
  create: jest.Mock;
  findById: jest.Mock;
  setStatus: jest.Mock;
  hash: jest.Mock;
  revokeAllUserSessions: jest.Mock;
  auditRecord: jest.Mock;
  profileUpdate: jest.Mock;
  transaction: jest.Mock;
}

function build(): Stub {
  const findByEmail = jest.fn().mockResolvedValue(null);
  const create = jest.fn();
  const findById = jest.fn();
  const setStatus = jest.fn().mockResolvedValue(undefined);
  const usersService = { findByEmail, create, findById, setStatus } as unknown as UsersService;

  const hash = jest.fn().mockResolvedValue('argon2-hash');
  const passwords = { hash } as unknown as PasswordService;

  const revokeAllUserSessions = jest.fn().mockResolvedValue(undefined);
  const auth = { revokeAllUserSessions } as unknown as AuthService;

  const auditRecord = jest.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord } as unknown as AuditService;

  const profileUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    getRepository: jest.fn().mockReturnValue({ update: profileUpdate }),
  } as unknown as EntityManager;

  const transaction = jest
    .fn()
    .mockImplementation((cb: (manager: EntityManager) => Promise<unknown>) => cb(manager));
  const dataSource = { transaction } as unknown as DataSource;

  const service = new ChildAccountService(dataSource, usersService, passwords, auth, audit);

  return {
    service,
    findByEmail,
    create,
    findById,
    setStatus,
    hash,
    revokeAllUserSessions,
    auditRecord,
    profileUpdate,
    transaction,
  };
}

describe('ChildAccountService.createLogin', () => {
  const input = { email: 'child@example.com', password: 'Sup3rSecret!23' };

  it('rejects a profile that is not a child', async () => {
    const { service, hash } = build();
    const profile = childProfile({ isChild: false });

    try {
      await service.createLogin(ACTOR, profile, input);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        errorCode: ErrorCode.NOT_A_CHILD_PROFILE,
      });
    }
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects a profile that already has a login', async () => {
    const { service, hash } = build();
    const profile = childProfile({ childUserId: 'existing-child-user' });

    try {
      await service.createLogin(ACTOR, profile, input);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        errorCode: ErrorCode.CHILD_LOGIN_EXISTS,
      });
    }
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects an email already in use by another account', async () => {
    const { service, findByEmail, hash, transaction } = build();
    findByEmail.mockResolvedValue({ id: 'someone-else' } as User);

    try {
      await service.createLogin(ACTOR, childProfile(), input);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      // Intentionally not enumeration-safe: the caller is an authenticated
      // parent choosing the address, not an anonymous visitor probing it.
      expect((err as ConflictException).getResponse()).toMatchObject({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
    }
    expect(hash).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('hashes the password, creates the child user in a transaction, links the profile, and audits against the child', async () => {
    const { service, hash, create, profileUpdate, auditRecord, transaction } = build();
    create.mockResolvedValue({ id: 'child-user-1', email: input.email } as User);
    const profile = childProfile();

    const result = await service.createLogin(ACTOR, profile, input);

    expect(hash).toHaveBeenCalledWith(input.password);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: input.email,
        role: Role.PlayerParent,
        passwordHash: 'argon2-hash',
        firstName: profile.displayName,
        emailVerified: true,
        mustSetPassword: false,
        status: UserStatus.Active,
      }),
      expect.anything(),
    );
    expect(profileUpdate).toHaveBeenCalledWith({ id: profile.id }, { childUserId: 'child-user-1' });
    // targetUserId is the new child user, not the parent (ACTOR.userId).
    expect(auditRecord).toHaveBeenCalledWith({
      action: AUDIT_CHILD_LOGIN_CREATED,
      actor: ACTOR,
      targetUserId: 'child-user-1',
      target: { type: 'PlayerProfile', id: profile.id },
    });
    expect(result).toEqual({
      playerProfileId: profile.id,
      displayName: profile.displayName,
      childUserId: 'child-user-1',
      email: input.email,
    });
  });

  it('audits only after the transaction has committed', async () => {
    const order: string[] = [];
    const { service, create, profileUpdate, auditRecord } = build();
    create.mockImplementation(async () => {
      order.push('create-user');
      return { id: 'child-user-1', email: input.email } as User;
    });
    profileUpdate.mockImplementation(async () => {
      order.push('link-profile');
      return { affected: 1 };
    });
    auditRecord.mockImplementation(async () => {
      order.push('audit');
    });

    await service.createLogin(ACTOR, childProfile(), input);

    expect(order).toEqual(['create-user', 'link-profile', 'audit']);
  });
});

describe('ChildAccountService.revokeLogin', () => {
  it('404s a profile with no login to revoke', async () => {
    const { service } = build();
    const profile = childProfile({ childUserId: null });

    try {
      await service.revokeLogin(ACTOR, profile);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        errorCode: ErrorCode.NOT_FOUND,
      });
    }
  });

  it('unlinks the profile, deactivates the child user, revokes sessions, and audits against the child', async () => {
    const { service, profileUpdate, setStatus, revokeAllUserSessions, auditRecord } = build();
    const profile = childProfile({ childUserId: 'child-user-1' });

    await service.revokeLogin(ACTOR, profile);

    expect(profileUpdate).toHaveBeenCalledWith({ id: profile.id }, { childUserId: null });
    expect(setStatus).toHaveBeenCalledWith('child-user-1', UserStatus.Inactive, expect.anything());
    expect(revokeAllUserSessions).toHaveBeenCalledWith('child-user-1', 'child-login-revoked');
    expect(auditRecord).toHaveBeenCalledWith({
      action: AUDIT_CHILD_LOGIN_REVOKED,
      actor: ACTOR,
      targetUserId: 'child-user-1',
      target: { type: 'PlayerProfile', id: profile.id },
    });
  });

  it('revokes sessions and audits only after the transaction has committed', async () => {
    const order: string[] = [];
    const { service, profileUpdate, setStatus, revokeAllUserSessions, auditRecord } = build();
    profileUpdate.mockImplementation(async () => {
      order.push('unlink-profile');
      return { affected: 1 };
    });
    setStatus.mockImplementation(async () => {
      order.push('deactivate-user');
    });
    revokeAllUserSessions.mockImplementation(async () => {
      order.push('revoke-sessions');
    });
    auditRecord.mockImplementation(async () => {
      order.push('audit');
    });

    await service.revokeLogin(ACTOR, childProfile({ childUserId: 'child-user-1' }));

    // Sessions die only once the DB write is durable, otherwise a mid-transaction
    // failure would revoke access to an account that never actually lost its login.
    expect(order).toEqual(['unlink-profile', 'deactivate-user', 'revoke-sessions', 'audit']);
  });
});

describe('ChildAccountService.loginStatus', () => {
  it('reports no login when the profile was never linked', async () => {
    const { service, findById } = build();

    await expect(service.loginStatus(childProfile({ childUserId: null }))).resolves.toEqual({
      hasLogin: false,
    });
    expect(findById).not.toHaveBeenCalled();
  });

  it('reports no login when the linked user id no longer resolves', async () => {
    const { service, findById } = build();
    findById.mockResolvedValue(null);

    await expect(
      service.loginStatus(childProfile({ childUserId: 'child-user-1' })),
    ).resolves.toEqual({ hasLogin: false });
    expect(findById).toHaveBeenCalledWith('child-user-1');
  });

  it('reports login details when the linked user resolves', async () => {
    const { service, findById } = build();
    findById.mockResolvedValue({ id: 'child-user-1', email: 'child@example.com' } as User);

    await expect(
      service.loginStatus(childProfile({ childUserId: 'child-user-1' })),
    ).resolves.toEqual({
      hasLogin: true,
      childUserId: 'child-user-1',
      email: 'child@example.com',
    });
  });
});
