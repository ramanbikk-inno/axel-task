import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';

import { AuthService } from '../../src/modules/auth/auth.service';
import { ImpersonationLogService } from '../../src/modules/impersonation/impersonation-log.service';
import { PlayersService } from '../../src/modules/players/players.service';
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

interface RepoMock {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
}

function repoMock(): RepoMock {
  return {
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
    findOne: jest.fn(),
  };
}

describe('AuthService (login + register)', () => {
  let service: AuthService;
  let usersService: jest.Mocked<
    Pick<UsersService, 'findByEmail' | 'findByEmailWithPassword' | 'create' | 'touchLastLogin'>
  >;
  let passwords: jest.Mocked<Pick<PasswordService, 'hash' | 'verify' | 'needsRehash'>>;
  let tokens: jest.Mocked<
    Pick<
      TokenService,
      'signAccess' | 'signRefresh' | 'hashOpaqueToken' | 'generateOpaqueToken' | 'accessTtlSeconds'
    >
  >;
  let mail: jest.Mocked<Pick<MailService, 'sendVerificationEmail'>>;
  let sessions: RepoMock;
  let refreshTokens: RepoMock;
  /** Ordered log of the two things whose relative order matters in register(). */
  let calls: string[];

  const baseUser: User = {
    id: 'user-1',
    email: 'player@example.com',
    passwordHash: 'argon-hash',
    role: Role.PlayerParent,
    status: UserStatus.Active,
    emailVerified: true,
    emailVerifiedAt: new Date('2026-06-01T00:00:00.000Z'),
    mustSetPassword: false,
    isChildAccount: false,
    firstName: 'Pat',
    lastName: 'Player',
    phone: null,
    photoUrl: null,
    tokenVersion: 0,
    lastLoginAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    deletedAt: null,
  } as User;

  beforeEach(async () => {
    calls = [];
    usersService = {
      findByEmail: jest.fn(),
      findByEmailWithPassword: jest.fn(),
      create: jest.fn(),
      touchLastLogin: jest.fn(),
    };
    passwords = {
      hash: jest.fn(),
      verify: jest.fn(),
      needsRehash: jest.fn().mockReturnValue(false),
    };
    passwords.hash.mockImplementation(async () => {
      calls.push('hash');
      return 'argon-dummy';
    });
    tokens = {
      signAccess: jest.fn(),
      signRefresh: jest.fn(),
      accessTtlSeconds: jest.fn().mockReturnValue(900),
      hashOpaqueToken: jest.fn(),
      generateOpaqueToken: jest.fn(),
    };
    tokens.generateOpaqueToken.mockReturnValue({ token: 'verify-tok', tokenHash: 'verify-hash' });
    tokens.signAccess.mockReturnValue('access.jwt');
    tokens.signRefresh.mockReturnValue({
      token: 'refresh.jwt',
      jti: 'jti-1',
      familyId: 'fam-1',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    tokens.hashOpaqueToken.mockReturnValue('refresh-hash');
    mail = { sendVerificationEmail: jest.fn() };
    sessions = repoMock();
    sessions.save = jest.fn(async (x: Partial<AuthSession>) => ({ id: 'session-1', ...x }));
    refreshTokens = repoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repoMock() },
        { provide: getRepositoryToken(AuthSession), useValue: sessions },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: getRepositoryToken(EmailVerificationToken), useValue: repoMock() },
        { provide: getRepositoryToken(PasswordResetToken), useValue: repoMock() },
        { provide: getRepositoryToken(AccountSetupToken), useValue: repoMock() },
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
          // register() runs inside a transaction; the callback gets the same
          // repository stubs the rest of these providers use.
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: unknown) => unknown) => {
              calls.push('transaction');
              return cb({ getRepository: () => repoMock() });
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string): unknown => (k === 'MIN_SELF_REGISTRATION_AGE' ? 18 : undefined),
          },
        },
        { provide: ClockService, useValue: new ClockService() },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('login returns tokens for a verified active user with correct password', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(baseUser);
    passwords.verify.mockResolvedValue(true);

    const result = await service.login(
      { email: 'player@example.com', password: 'Str0ng!Passw0rd' },
      { ip: '1.2.3.4', userAgent: 'jest' },
    );

    expect(result.accessToken).toBe('access.jwt');
    expect(result.refreshToken).toBe('refresh.jwt');
    expect(result.tokenType).toBe('Bearer');
    expect(usersService.touchLastLogin).toHaveBeenCalledWith('user-1', expect.any(Date));
    expect(refreshTokens.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'jti-1',
        sessionId: 'session-1',
        userId: 'user-1',
        familyId: 'fam-1',
        tokenHash: 'refresh-hash',
      }),
    );
  });

  it('login throws EMAIL_NOT_VERIFIED (403) when emailVerified is false', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue({ ...baseUser, emailVerified: false });
    passwords.verify.mockResolvedValue(true);

    await expect(
      service.login({ email: 'player@example.com', password: 'Str0ng!Passw0rd' }, {}),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.EMAIL_NOT_VERIFIED } });
  });

  it('login throws ACCOUNT_INACTIVE (403) when status is Inactive', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue({
      ...baseUser,
      status: UserStatus.Inactive,
    });
    passwords.verify.mockResolvedValue(true);

    await expect(
      service.login({ email: 'player@example.com', password: 'Str0ng!Passw0rd' }, {}),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.ACCOUNT_INACTIVE } });
  });

  it('login throws SETUP_REQUIRED (403) when mustSetPassword is true', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue({ ...baseUser, mustSetPassword: true });
    passwords.verify.mockResolvedValue(true);

    await expect(
      service.login({ email: 'player@example.com', password: 'Str0ng!Passw0rd' }, {}),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.SETUP_REQUIRED } });
  });

  it('login throws INVALID_CREDENTIALS (401) on unknown email and still runs a verify (constant-time)', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(null);
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.login({ email: 'nobody@example.com', password: 'Str0ng!Passw0rd' }, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.verify).toHaveBeenCalled();
  });

  it('login throws INVALID_CREDENTIALS (401) on wrong password', async () => {
    usersService.findByEmailWithPassword.mockResolvedValue(baseUser);
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.login({ email: 'player@example.com', password: 'wrongpassword' }, {}),
    ).rejects.toMatchObject({ response: { errorCode: ErrorCode.INVALID_CREDENTIALS } });
  });

  it('register returns the generic enumeration-safe message for a new email and creates the user', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ ...baseUser, id: 'new-user', emailVerified: false });

    const result = await service.register({
      email: 'fresh@example.com',
      password: 'Str0ng!Passw0rd',
      birthDate: '1994-03-22',
    });

    expect(result).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'fresh@example.com',
        role: Role.PlayerParent,
        emailVerified: false,
      }),
      // Registration runs in a transaction, so the manager is threaded through.
      expect.anything(),
    );
  });

  it('register returns the same generic message for an existing email and does NOT create or throw', async () => {
    usersService.findByEmail.mockResolvedValue(baseUser);

    const result = await service.register({
      email: 'player@example.com',
      password: 'Str0ng!Passw0rd',
      birthDate: '1994-03-22',
    });

    expect(result).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('hashes before opening the transaction, not inside it', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({ ...baseUser, id: 'new-user', emailVerified: false });

    await service.register({
      email: 'fresh@example.com',
      password: 'Str0ng!Passw0rd',
      birthDate: '1994-03-22',
    });

    // Reversed, argon2id's ~40ms runs on a checked-out pooled connection.
    expect(calls).toEqual(['hash', 'transaction']);
  });

  it('hashes even when the address is taken, so the answer is not measurably faster', async () => {
    usersService.findByEmail.mockResolvedValue(baseUser);

    await service.register({
      email: 'player@example.com',
      password: 'Str0ng!Passw0rd',
      birthDate: '1994-03-22',
    });

    // Skipping the hash here would let a caller time the difference and learn
    // which addresses are registered — what the generic message exists to hide.
    expect(calls).toEqual(['hash']);
  });

  it('createUnverifiedAccount stores the hash it is handed and never computes one', async () => {
    usersService.create.mockResolvedValue({ ...baseUser, id: 'invited-coach' });
    const manager = { getRepository: () => repoMock() } as unknown as EntityManager;

    await service.createUnverifiedAccount(
      { email: 'coach@example.com', passwordHash: 'pre-computed-hash', role: Role.Coach },
      manager,
    );

    // This helper runs inside a caller's transaction every time it is used, so
    // hashing here would put argon2 back on a held connection — in the coach
    // invite and ShareLink join flows as well as registration.
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: 'pre-computed-hash' }),
      manager,
    );
  });
});
