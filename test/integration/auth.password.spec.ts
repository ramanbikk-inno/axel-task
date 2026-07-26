import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { IsNull } from 'typeorm';

import { AuthService } from '../../src/modules/auth/auth.service';
import { ImpersonationLogService } from '../../src/modules/impersonation/impersonation-log.service';
import { PlayersService } from '../../src/modules/players/players.service';
import { Principal } from '../../src/modules/auth/principal';
import { TokenService } from '../../src/modules/auth/token.service';
import { User } from '../../src/modules/users/entities/user.entity';
import { Role, UserStatus } from '../../src/modules/users/entities/user.enums';
import { AuthSession } from '../../src/modules/auth/entities/auth-session.entity';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { EmailVerificationToken } from '../../src/modules/auth/entities/email-verification-token.entity';
import { PasswordResetToken } from '../../src/modules/auth/entities/password-reset-token.entity';
import { AccountSetupToken } from '../../src/modules/auth/entities/account-setup-token.entity';
import { UsersService } from '../../src/modules/users/users.service';
import { PasswordService } from '../../src/shared/crypto/password.service';
import { MailService } from '../../src/modules/mail/mail.service';
import { ClockService } from '../../src/shared/clock/clock.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';

const NOW = new Date('2026-06-08T00:00:00.000Z');

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

class FakeClock {
  now(): Date {
    return new Date(NOW.getTime());
  }
}

describe('AuthService password reset & change', () => {
  let service: AuthService;
  let usersService: {
    findByEmail: jest.Mock;
    findById: jest.Mock;
    findByIdWithPassword: jest.Mock;
    setPasswordAndBumpVersion: jest.Mock;
  };
  let passwordResets: { save: jest.Mock; create: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let sessions: { update: jest.Mock; save: jest.Mock; create: jest.Mock };
  let tokens: jest.Mocked<
    Pick<
      TokenService,
      'generateOpaqueToken' | 'hashOpaqueToken' | 'signAccess' | 'signRefresh' | 'accessTtlSeconds'
    >
  >;
  let passwords: jest.Mocked<Pick<PasswordService, 'hash' | 'verify'>>;
  let mail: jest.Mocked<Pick<MailService, 'sendPasswordResetEmail' | 'sendPasswordChangedEmail'>>;

  beforeEach(async () => {
    usersService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      findByIdWithPassword: jest.fn(),
      setPasswordAndBumpVersion: jest.fn().mockResolvedValue(undefined),
    };
    passwordResets = {
      save: jest.fn(async (x) => x),
      create: jest.fn((x) => x),
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    };
    sessions = {
      update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: Record<string, unknown>) => ({ ...x, id: 'new-session-1' })),
    };
    tokens = {
      generateOpaqueToken: jest.fn(),
      accessTtlSeconds: jest.fn().mockReturnValue(900),
      hashOpaqueToken: jest.fn().mockReturnValue('refresh-hash'),
      signAccess: jest.fn().mockReturnValue('new-access-token'),
      signRefresh: jest.fn().mockReturnValue({
        token: 'new-refresh-token',
        jti: 'jti-1',
        familyId: 'fam-1',
        expiresAt: new Date(NOW.getTime() + 1000),
      }),
    };
    passwords = { hash: jest.fn(), verify: jest.fn() };
    mail = { sendPasswordResetEmail: jest.fn(), sendPasswordChangedEmail: jest.fn() };
    mail.sendPasswordResetEmail.mockResolvedValue(undefined);
    mail.sendPasswordChangedEmail.mockResolvedValue(undefined);

    function repoStub(): {
      findOne: jest.Mock;
      save: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    } {
      return {
        findOne: jest.fn(),
        save: jest.fn(async (x: unknown) => x),
        create: jest.fn((x: unknown) => x),
        update: jest.fn(),
      };
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repoStub() },
        { provide: getRepositoryToken(AuthSession), useValue: sessions },
        { provide: getRepositoryToken(RefreshToken), useValue: repoStub() },
        { provide: getRepositoryToken(EmailVerificationToken), useValue: repoStub() },
        { provide: getRepositoryToken(PasswordResetToken), useValue: passwordResets },
        { provide: getRepositoryToken(AccountSetupToken), useValue: repoStub() },
        { provide: TokenService, useValue: tokens },
        { provide: PasswordService, useValue: passwords },
        { provide: MailService, useValue: mail },
        { provide: UsersService, useValue: usersService },
        {
          provide: ImpersonationLogService,
          useValue: {
            closeForSession: jest.fn().mockResolvedValue(undefined),
            closeForTargetUser: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PlayersService,
          useValue: { create: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string): unknown => (k === 'MIN_SELF_REGISTRATION_AGE' ? 18 : undefined),
          },
        },
        { provide: ClockService, useValue: new FakeClock() },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('forgotPassword issues a hashed reset token (1h) + sends email when the user exists', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      status: UserStatus.Active,
    } as User);
    tokens.generateOpaqueToken.mockReturnValue({ token: 'reset-plain', tokenHash: 'reset-hash' });

    await service.forgotPassword('u@example.com');

    expect(passwordResets.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tokenHash: 'reset-hash',
        consumedAt: null,
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      }),
    );
    expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith('u@example.com', 'reset-plain');
  });

  it('forgotPassword is an enumeration-safe no-op for an unknown email', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(service.forgotPassword('ghost@example.com')).resolves.toBeUndefined();
    expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('resetPassword consumes the token, bumps tokenVersion, revokes sessions, sends notice', async () => {
    tokens.hashOpaqueToken.mockReturnValue('reset-hash');
    passwordResets.findOne.mockResolvedValue({
      id: 'prt-1',
      userId: 'user-1',
      tokenHash: 'reset-hash',
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    } as PasswordResetToken);
    passwords.hash.mockResolvedValue('new-hash');
    usersService.findById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' } as User);

    await service.resetPassword({ token: 'reset-plain', newPassword: 'NewStr0ng!Pass' });

    expect(passwordResets.update).toHaveBeenCalledWith({ id: 'prt-1' }, { consumedAt: NOW });
    expect(usersService.setPasswordAndBumpVersion).toHaveBeenCalledWith('user-1', 'new-hash');
    expect(sessions.update).toHaveBeenCalledWith(
      { userId: 'user-1', revokedAt: IsNull() },
      { revokedAt: NOW, revokedReason: 'password-reset' },
    );
    expect(mail.sendPasswordChangedEmail).toHaveBeenCalledWith('u@example.com');
  });

  it('resetPassword throws EXPIRED_TOKEN (410) on an expired DB row (fake clock)', async () => {
    tokens.hashOpaqueToken.mockReturnValue('reset-hash');
    passwordResets.findOne.mockResolvedValue({
      id: 'prt-1',
      userId: 'user-1',
      tokenHash: 'reset-hash',
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() - 1000),
    } as PasswordResetToken);

    await expect(
      service.resetPassword({ token: 'reset-plain', newPassword: 'NewStr0ng!Pass' }),
    ).rejects.toMatchObject({
      status: 410,
      response: { errorCode: ErrorCode.EXPIRED_TOKEN },
    });
  });

  it('changePassword verifies the current password, rehashes, bumps version, revokes every session and returns a fresh pair', async () => {
    usersService.findByIdWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      passwordHash: 'old-hash',
    } as User);
    // Re-read after the bump, so the new tokens carry the new version.
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      role: Role.PlayerParent,
      tokenVersion: 1,
    } as User);
    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('rehashed');

    const result = await service.changePassword(
      principal(),
      { currentPassword: 'OldStr0ng!Pass', newPassword: 'NewStr0ng!Pass' },
      { ip: '203.0.113.5', userAgent: 'jest' },
    );

    expect(usersService.setPasswordAndBumpVersion).toHaveBeenCalledWith('user-1', 'rehashed');

    // A stolen session must not survive the standard remediation.
    expect(sessions.update).toHaveBeenCalledWith(
      { userId: 'user-1', revokedAt: IsNull() },
      { revokedAt: NOW, revokedReason: 'password-change' },
    );

    // ...and the caller is not signed out by their own password change.
    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(tokens.signAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', tokenVersion: 1 }),
    );
    expect(mail.sendPasswordChangedEmail).toHaveBeenCalledWith('u@example.com');
  });

  it('changePassword throws INVALID_CREDENTIALS (401) when the current password is wrong', async () => {
    usersService.findByIdWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      passwordHash: 'old-hash',
    } as User);
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.changePassword(
        principal(),
        { currentPassword: 'WrongPass!123', newPassword: 'NewStr0ng!Pass' },
        {},
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { errorCode: ErrorCode.INVALID_CREDENTIALS },
    });
  });

  /**
   * changePassword revokes every session and mints a fresh, non-impersonated
   * one. Reached from inside an impersonation session that would hand the admin
   * an ordinary durable login as the target — no `impersonated_by`, no
   * one-hour cap, nothing in the impersonation log after the exit.
   */
  it('refuses to change a password from inside an impersonation session', async () => {
    usersService.findByIdWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'u@example.com',
      passwordHash: 'old-hash',
    } as User);
    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('rehashed');

    await expect(
      service.changePassword(
        principal({ impersonating: true, actor: { userId: 'admin-1' } }),
        { currentPassword: 'OldStr0ng!Pass', newPassword: 'NewStr0ng!Pass' },
        {},
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: { errorCode: ErrorCode.FORBIDDEN_DURING_IMPERSONATION },
    });

    // Refused before any of it happened, not merely reported afterwards.
    expect(usersService.setPasswordAndBumpVersion).not.toHaveBeenCalled();
    expect(sessions.update).not.toHaveBeenCalled();
    expect(sessions.save).not.toHaveBeenCalled();
    expect(mail.sendPasswordChangedEmail).not.toHaveBeenCalled();
  });
});
