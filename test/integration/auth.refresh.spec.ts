import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthService } from '../../src/modules/auth/auth.service';
import { ImpersonationLogService } from '../../src/modules/impersonation/impersonation-log.service';
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
import { RefreshClaims } from '../../src/modules/auth/auth.types';

class FakeClock {
  private current: Date = new Date('2026-01-01T00:00:00.000Z');
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('AuthService.refresh (rotation + reuse detection)', () => {
  let service: AuthService;
  let refreshRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; update: jest.Mock };
  let sessionRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let tokens: jest.Mocked<
    Pick<
      TokenService,
      'verifyRefresh' | 'hashOpaqueToken' | 'signAccess' | 'signRefresh' | 'accessTtlSeconds'
    >
  >;
  let clock: FakeClock;

  const user: User = {
    id: 'user-1',
    email: 'p@example.com',
    role: Role.PlayerParent,
    status: UserStatus.Active,
    tokenVersion: 0,
  } as User;

  const validClaims: RefreshClaims = {
    sub: 'user-1',
    sessionId: 'session-1',
    jti: 'jti-1',
    familyId: 'fam-1',
  };

  beforeEach(async () => {
    refreshRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (x) => x),
      create: jest.fn((x) => x),
      update: jest.fn(async () => undefined),
    };
    sessionRepo = {
      findOne: jest.fn(async () => ({
        id: 'session-1',
        userId: 'user-1',
        activeTrainerProfileId: null,
        revokedAt: null,
      })),
      save: jest.fn(async (x) => ({ id: 'session-1', ...x })),
      create: jest.fn((x) => x),
    };
    userRepo = { findOne: jest.fn(async () => user) };
    clock = new FakeClock();
    clock.set(new Date('2026-06-08T00:00:00.000Z'));
    tokens = {
      verifyRefresh: jest.fn(),
      hashOpaqueToken: jest.fn(),
      signAccess: jest.fn(),
      signRefresh: jest.fn(),
      accessTtlSeconds: jest.fn().mockReturnValue(900),
    };
    tokens.verifyRefresh.mockReturnValue(validClaims);
    tokens.hashOpaqueToken.mockImplementation((t: string) => `hash:${t}`);
    tokens.signAccess.mockReturnValue('new.access.jwt');
    tokens.signRefresh.mockReturnValue({
      token: 'new.refresh.jwt',
      jti: 'jti-2',
      familyId: 'fam-1',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
    });

    function repoStub(): { findOne: jest.Mock; save: jest.Mock; create: jest.Mock } {
      return {
        findOne: jest.fn(),
        save: jest.fn(async (x: unknown) => x),
        create: jest.fn((x: unknown) => x),
      };
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(AuthSession), useValue: sessionRepo },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshRepo },
        { provide: getRepositoryToken(EmailVerificationToken), useValue: repoStub() },
        { provide: getRepositoryToken(PasswordResetToken), useValue: repoStub() },
        { provide: getRepositoryToken(AccountSetupToken), useValue: repoStub() },
        { provide: TokenService, useValue: tokens },
        { provide: PasswordService, useValue: { hash: jest.fn(), verify: jest.fn() } },
        { provide: MailService, useValue: {} },
        { provide: UsersService, useValue: { findById: jest.fn(async () => user) } },
        {
          provide: ImpersonationLogService,
          useValue: {
            closeForSession: jest.fn().mockResolvedValue(undefined),
            closeForTargetUser: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string): unknown => (k === 'MIN_SELF_REGISTRATION_AGE' ? 18 : undefined),
          },
        },
        { provide: ClockService, useValue: clock },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('rotates: revokes the presented token (sets replacedById) and issues a new pair', async () => {
    refreshRepo.findOne.mockResolvedValue({
      id: 'jti-1',
      sessionId: 'session-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash:old.refresh.jwt',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      revokedAt: null,
      replacedById: null,
    });

    const result = await service.refresh('old.refresh.jwt', { ip: '1.1.1.1', userAgent: 'jest' });

    expect(result.accessToken).toBe('new.access.jwt');
    expect(result.refreshToken).toBe('new.refresh.jwt');
    expect(result.tokenType).toBe('Bearer');
    expect(refreshRepo.update).toHaveBeenCalledWith(
      { id: 'jti-1' },
      expect.objectContaining({ revokedAt: expect.any(Date), replacedById: 'jti-2' }),
    );
    expect(refreshRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jti-2', familyId: 'fam-1', sessionId: 'session-1' }),
    );
  });

  it('reuse detection: an already-revoked token revokes the whole family and throws TOKEN_REUSED (401)', async () => {
    refreshRepo.findOne.mockResolvedValue({
      id: 'jti-1',
      sessionId: 'session-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash:old.refresh.jwt',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      revokedAt: new Date('2026-06-07T00:00:00.000Z'),
      replacedById: 'jti-x',
    });

    await expect(service.refresh('old.refresh.jwt', {})).rejects.toMatchObject({
      response: { errorCode: ErrorCode.TOKEN_REUSED },
    });
    expect(refreshRepo.update).toHaveBeenCalledWith(
      { familyId: 'fam-1' },
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('rejects when no refresh row matches the jti', async () => {
    refreshRepo.findOne.mockResolvedValue(null);

    await expect(service.refresh('old.refresh.jwt', {})).rejects.toMatchObject({
      response: { errorCode: ErrorCode.REFRESH_TOKEN_INVALID },
    });
  });

  it('rejects when the stored tokenHash does not match the presented token', async () => {
    refreshRepo.findOne.mockResolvedValue({
      id: 'jti-1',
      sessionId: 'session-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash:some-other-token',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      revokedAt: null,
      replacedById: null,
    });

    await expect(service.refresh('old.refresh.jwt', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the DB row is past expiresAt (fake-clock testable)', async () => {
    clock.set(new Date('2026-07-01T00:00:00.000Z'));
    refreshRepo.findOne.mockResolvedValue({
      id: 'jti-1',
      sessionId: 'session-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash:old.refresh.jwt',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      revokedAt: null,
      replacedById: null,
    });

    await expect(service.refresh('old.refresh.jwt', {})).rejects.toMatchObject({
      response: { errorCode: ErrorCode.REFRESH_TOKEN_INVALID },
    });
  });
});
