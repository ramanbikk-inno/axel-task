import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthService } from '../../src/modules/auth/auth.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { User } from '../../src/modules/users/entities/user.entity';
import { Role } from '../../src/modules/users/entities/user.enums';
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

class FakeClock {
  now(): Date {
    return new Date(NOW.getTime());
  }
}

describe('AuthService email verification', () => {
  let service: AuthService;
  let usersService: {
    findByEmail: jest.Mock;
    create: jest.Mock;
    markEmailVerified: jest.Mock;
    findById: jest.Mock;
  };
  let emailVerifications: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let tokens: jest.Mocked<Pick<TokenService, 'generateOpaqueToken' | 'hashOpaqueToken'>>;
  let mail: jest.Mocked<Pick<MailService, 'sendVerificationEmail' | 'sendWelcomeEmail'>>;

  beforeEach(async () => {
    usersService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
      markEmailVerified: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn(),
    };
    emailVerifications = {
      save: jest.fn(async (x) => x),
      create: jest.fn((x) => x),
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    };
    tokens = { generateOpaqueToken: jest.fn(), hashOpaqueToken: jest.fn() };
    mail = { sendVerificationEmail: jest.fn(), sendWelcomeEmail: jest.fn() };
    mail.sendVerificationEmail.mockResolvedValue(undefined);
    mail.sendWelcomeEmail.mockResolvedValue(undefined);

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
        { provide: getRepositoryToken(AuthSession), useValue: repoStub() },
        { provide: getRepositoryToken(RefreshToken), useValue: repoStub() },
        { provide: getRepositoryToken(EmailVerificationToken), useValue: emailVerifications },
        { provide: getRepositoryToken(PasswordResetToken), useValue: repoStub() },
        { provide: getRepositoryToken(AccountSetupToken), useValue: repoStub() },
        { provide: TokenService, useValue: tokens },
        {
          provide: PasswordService,
          useValue: { hash: jest.fn().mockResolvedValue('argon'), verify: jest.fn() },
        },
        { provide: MailService, useValue: mail },
        { provide: UsersService, useValue: usersService },
        { provide: ClockService, useValue: new FakeClock() },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('register issues a hashed verification token (24h) and sends the email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.create.mockResolvedValue({
      id: 'user-new-1',
      email: 'new@example.com',
      role: Role.PlayerParent,
    } as User);
    tokens.generateOpaqueToken.mockReturnValue({ token: 'plain-token-abc', tokenHash: 'hash-abc' });

    const result = await service.register({
      email: 'new@example.com',
      password: 'Str0ng!Passw0rd',
    });

    expect(result).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
    expect(emailVerifications.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-new-1',
        tokenHash: 'hash-abc',
        consumedAt: null,
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      }),
    );
    expect(mail.sendVerificationEmail).toHaveBeenCalledWith('new@example.com', 'plain-token-abc');
  });

  it('register on an existing email is an enumeration-safe no-op (still {message}, no token, no email)', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'existing-1',
      email: 'taken@example.com',
    } as User);

    const result = await service.register({
      email: 'taken@example.com',
      password: 'Str0ng!Passw0rd',
    });

    expect(result).toEqual({
      message: 'Registration received. Check your email to verify your account.',
    });
    expect(usersService.create).not.toHaveBeenCalled();
    expect(tokens.generateOpaqueToken).not.toHaveBeenCalled();
    expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('verifyEmail consumes a valid token, marks the user verified and sends welcome', async () => {
    tokens.hashOpaqueToken.mockReturnValue('hash-abc');
    emailVerifications.findOne.mockResolvedValue({
      id: 'evt-1',
      userId: 'user-new-1',
      tokenHash: 'hash-abc',
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    } as EmailVerificationToken);
    usersService.findById.mockResolvedValue({
      id: 'user-new-1',
      email: 'new@example.com',
      firstName: 'Ada',
    } as User);

    await service.verifyEmail('plain-token-abc');

    expect(emailVerifications.update).toHaveBeenCalledWith({ id: 'evt-1' }, { consumedAt: NOW });
    expect(usersService.markEmailVerified).toHaveBeenCalledWith('user-new-1', NOW);
    expect(mail.sendWelcomeEmail).toHaveBeenCalledWith('new@example.com', 'Ada');
  });

  it('verifyEmail throws INVALID_TOKEN (401) when no row matches', async () => {
    tokens.hashOpaqueToken.mockReturnValue('hash-missing');
    emailVerifications.findOne.mockResolvedValue(null);

    await expect(service.verifyEmail('nope')).rejects.toMatchObject({
      status: 401,
      response: { errorCode: ErrorCode.INVALID_TOKEN },
    });
  });

  it('verifyEmail throws TOKEN_ALREADY_USED (409) when already consumed', async () => {
    tokens.hashOpaqueToken.mockReturnValue('hash-abc');
    emailVerifications.findOne.mockResolvedValue({
      id: 'evt-1',
      userId: 'user-new-1',
      tokenHash: 'hash-abc',
      consumedAt: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    } as EmailVerificationToken);

    await expect(service.verifyEmail('plain')).rejects.toMatchObject({
      status: 409,
      response: { errorCode: ErrorCode.TOKEN_ALREADY_USED },
    });
  });

  it('verifyEmail throws EXPIRED_TOKEN (410) when the DB expiresAt has passed (fake clock)', async () => {
    tokens.hashOpaqueToken.mockReturnValue('hash-abc');
    emailVerifications.findOne.mockResolvedValue({
      id: 'evt-1',
      userId: 'user-new-1',
      tokenHash: 'hash-abc',
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() - 1000),
    } as EmailVerificationToken);

    await expect(service.verifyEmail('plain')).rejects.toMatchObject({
      status: 410,
      response: { errorCode: ErrorCode.EXPIRED_TOKEN },
    });
  });

  it('resendVerification is an enumeration-safe no-op for an unknown email (no throw, no email)', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(service.resendVerification('ghost@example.com')).resolves.toBeUndefined();
    expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
