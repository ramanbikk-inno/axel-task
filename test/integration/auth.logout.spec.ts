import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthService } from '../../src/modules/auth/auth.service';
import { ImpersonationLogService } from '../../src/modules/impersonation/impersonation-log.service';
import { TokenService } from '../../src/modules/auth/token.service';
import { User } from '../../src/modules/users/entities/user.entity';
import { AuthSession } from '../../src/modules/auth/entities/auth-session.entity';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { EmailVerificationToken } from '../../src/modules/auth/entities/email-verification-token.entity';
import { PasswordResetToken } from '../../src/modules/auth/entities/password-reset-token.entity';
import { AccountSetupToken } from '../../src/modules/auth/entities/account-setup-token.entity';
import { UsersService } from '../../src/modules/users/users.service';
import { PasswordService } from '../../src/shared/crypto/password.service';
import { MailService } from '../../src/modules/mail/mail.service';
import { ClockService } from '../../src/shared/clock/clock.service';

const NOW = new Date('2026-06-08T00:00:00.000Z');

class FakeClock {
  now(): Date {
    return new Date(NOW.getTime());
  }
}

describe('AuthService.logout', () => {
  let service: AuthService;
  let refreshTokens: { findOne: jest.Mock; update: jest.Mock };
  let sessions: { update: jest.Mock };
  let tokens: jest.Mocked<Pick<TokenService, 'verifyRefresh'>>;

  beforeEach(async () => {
    refreshTokens = {
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    };
    sessions = {
      update: jest.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    };
    tokens = { verifyRefresh: jest.fn() };

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
        { provide: getRepositoryToken(User), useValue: repoStub() },
        { provide: getRepositoryToken(AuthSession), useValue: sessions },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: getRepositoryToken(EmailVerificationToken), useValue: repoStub() },
        { provide: getRepositoryToken(PasswordResetToken), useValue: repoStub() },
        { provide: getRepositoryToken(AccountSetupToken), useValue: repoStub() },
        { provide: TokenService, useValue: tokens },
        { provide: PasswordService, useValue: { hash: jest.fn(), verify: jest.fn() } },
        { provide: MailService, useValue: {} },
        { provide: UsersService, useValue: { findById: jest.fn() } },
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
        { provide: ClockService, useValue: new FakeClock() },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('revokes the refresh row and its session, idempotently', async () => {
    const jti = 'jti-logout-1';
    const sessionId = 'sess-logout-1';

    tokens.verifyRefresh.mockReturnValue({ sub: 'user-1', sessionId, jti, familyId: 'fam-1' });
    refreshTokens.findOne.mockResolvedValue({
      id: jti,
      sessionId,
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: 'hash',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      revokedAt: null,
      replacedById: null,
    });

    await service.logout('refresh.jwt.value');

    expect(refreshTokens.update).toHaveBeenCalledWith({ id: jti }, { revokedAt: NOW });
    expect(sessions.update).toHaveBeenCalledWith(
      { id: sessionId },
      { revokedAt: NOW, revokedReason: 'logout' },
    );
  });

  it('is a no-op (no throw) when the refresh token is unverifiable', async () => {
    tokens.verifyRefresh.mockImplementation(() => {
      throw new Error('bad token');
    });

    await expect(service.logout('garbage')).resolves.toBeUndefined();
    expect(refreshTokens.update).not.toHaveBeenCalled();
  });

  it('is a no-op (no throw) when the refresh row does not exist', async () => {
    tokens.verifyRefresh.mockReturnValue({
      sub: 'user-1',
      sessionId: 'sess-x',
      jti: 'jti-x',
      familyId: 'fam-x',
    });
    refreshTokens.findOne.mockResolvedValue(null);

    await expect(service.logout('valid-but-unknown')).resolves.toBeUndefined();
    expect(refreshTokens.update).not.toHaveBeenCalled();
  });
});
