import { UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

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
import { RefreshClaims } from '../../src/modules/auth/auth.types';

function repoStub(): { findOne: jest.Mock; save: jest.Mock; create: jest.Mock } {
  return {
    findOne: jest.fn(),
    save: jest.fn(async (x: unknown) => x),
    create: jest.fn((x: unknown) => x),
  };
}

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
  let sessionRepo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; update: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let impersonationLogs: { closeForSession: jest.Mock; closeForTargetUser: jest.Mock };
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

  async function buildService(idleTimeout?: string): Promise<AuthService> {
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
        { provide: ImpersonationLogService, useValue: impersonationLogs },
        {
          provide: PlayersService,
          useValue: { create: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
        },
        {
          // register() runs inside a transaction; the callback gets the same
          // repository stubs the rest of these providers use.
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: unknown) => unknown) => cb({ getRepository: () => repoStub() }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string): unknown => {
              if (k === 'MIN_SELF_REGISTRATION_AGE') {
                return 18;
              }
              return k === 'SESSION_IDLE_TIMEOUT' ? idleTimeout : undefined;
            },
          },
        },
        { provide: ClockService, useValue: clock },
      ],
    }).compile();

    return module.get<AuthService>(AuthService);
  }

  beforeEach(async () => {
    refreshRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (x) => x),
      create: jest.fn((x) => x),
      update: jest.fn(async () => undefined),
    };
    sessionRepo = {
      // Matches clock.set below, so idle-timeout tests are the only ones that move it.
      findOne: jest.fn(async () => ({
        id: 'session-1',
        userId: 'user-1',
        activeTrainerProfileId: null,
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: new Date('2026-06-08T00:00:00.000Z'),
      })),
      save: jest.fn(async (x) => ({ id: 'session-1', ...x })),
      create: jest.fn((x) => x),
      update: jest.fn(async () => undefined),
    };
    userRepo = { findOne: jest.fn(async () => user) };
    impersonationLogs = {
      closeForSession: jest.fn().mockResolvedValue(undefined),
      closeForTargetUser: jest.fn().mockResolvedValue(undefined),
    };
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

    service = await buildService();
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

  it('reuse detection: an already-revoked token revokes the whole family and the session, and throws TOKEN_REUSED (401)', async () => {
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
    // The stolen family is only half the fix — an access token already minted
    // from a successful rotation is still valid until its own exp unless the
    // session itself dies too.
    expect(sessionRepo.update).toHaveBeenCalledWith(
      { id: 'session-1' },
      expect.objectContaining({ revokedAt: expect.any(Date), revokedReason: 'token-reuse' }),
    );
    expect(impersonationLogs.closeForSession).toHaveBeenCalledWith('session-1', expect.any(Date));
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

  describe('idle timeout', () => {
    const freshRefreshRow = {
      id: 'jti-1',
      sessionId: 'session-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash:old.refresh.jwt',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      revokedAt: null,
      replacedById: null,
    };

    it('rejects and revokes the session once the default 24h idle window has passed', async () => {
      refreshRepo.findOne.mockResolvedValue(freshRefreshRow);
      // lastUsedAt is fixed at 2026-06-08T00:00:00Z; push the clock 24h + 1s past it.
      clock.set(new Date('2026-06-09T00:00:01.000Z'));

      await expect(service.refresh('old.refresh.jwt', {})).rejects.toMatchObject({
        response: { errorCode: ErrorCode.REFRESH_TOKEN_INVALID },
      });
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('allows a refresh one second inside the 24h window', async () => {
      refreshRepo.findOne.mockResolvedValue(freshRefreshRow);
      clock.set(new Date('2026-06-08T23:59:59.000Z'));

      const result = await service.refresh('old.refresh.jwt', {});

      expect(result.accessToken).toBe('new.access.jwt');
    });

    it('honours a configured SESSION_IDLE_TIMEOUT instead of the 24h default', async () => {
      refreshRepo.findOne.mockResolvedValue(freshRefreshRow);
      // 30 minutes past lastUsedAt: inside the default, outside a 15m override.
      clock.set(new Date('2026-06-08T00:30:00.000Z'));

      const shortIdleService = await buildService('15m');

      await expect(shortIdleService.refresh('old.refresh.jwt', {})).rejects.toMatchObject({
        response: { errorCode: ErrorCode.REFRESH_TOKEN_INVALID },
      });
    });

    it('refuses to construct on a malformed SESSION_IDLE_TIMEOUT', async () => {
      // Boot-time failure, not a 500 on every refresh once the app is live.
      await expect(buildService('24hr')).rejects.toThrow(/Invalid duration/);
    });

    it('treats a null lastUsedAt as never idle (defensive branch)', async () => {
      refreshRepo.findOne.mockResolvedValue(freshRefreshRow);
      sessionRepo.findOne.mockResolvedValueOnce({
        id: 'session-1',
        userId: 'user-1',
        activeTrainerProfileId: null,
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: null,
      });
      clock.set(new Date('2026-06-10T00:00:00.000Z'));

      const result = await service.refresh('old.refresh.jwt', {});

      expect(result.accessToken).toBe('new.access.jwt');
    });
  });
});
