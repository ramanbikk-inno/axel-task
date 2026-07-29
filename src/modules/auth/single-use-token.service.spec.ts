import { ConflictException, GoneException, UnauthorizedException } from '@nestjs/common';
import { IsNull, Repository, UpdateResult } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AccountSetupToken } from './entities/account-setup-token.entity';
import { SingleUseTokenMessages, SingleUseTokenService } from './single-use-token.service';
import { TokenService } from './token.service';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const TOKEN = 'plaintext-opaque-token';
const TOKEN_HASH = 'a'.repeat(64);

const MESSAGES: SingleUseTokenMessages = {
  invalid: 'invalid-message',
  alreadyUsed: 'already-used-message',
  expired: 'expired-message',
};

type MockRepo = jest.Mocked<
  Pick<Repository<AccountSetupToken>, 'create' | 'save' | 'findOne' | 'update'>
>;

function buildRepo(): MockRepo {
  return {
    create: jest.fn((entity) => entity as AccountSetupToken),
    save: jest.fn(async (entity) => entity as AccountSetupToken),
    findOne: jest.fn(),
    update: jest.fn(),
  } as unknown as MockRepo;
}

function buildService(): { service: SingleUseTokenService; tokens: jest.Mocked<TokenService> } {
  const tokens = {
    generateOpaqueToken: jest.fn().mockReturnValue({ token: TOKEN, tokenHash: TOKEN_HASH }),
    hashOpaqueToken: jest.fn().mockReturnValue(TOKEN_HASH),
  } as unknown as jest.Mocked<TokenService>;
  const clock = { now: () => NOW } as unknown as ClockService;
  return { service: new SingleUseTokenService(tokens, clock), tokens };
}

function row(over: Partial<AccountSetupToken> = {}): AccountSetupToken {
  return {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: TOKEN_HASH,
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    createdAt: NOW,
    ...over,
  } as AccountSetupToken;
}

async function expectFailure(
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => Error,
  errorCode: ErrorCode,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ctor);
  await promise.catch((error: { getResponse: () => { errorCode: ErrorCode } }) => {
    expect(error.getResponse().errorCode).toBe(errorCode);
  });
}

describe('SingleUseTokenService', () => {
  describe('issue', () => {
    it('creates a fresh, unconsumed row expiring at now+ttlMs and returns the plaintext token', async () => {
      const repo = buildRepo();
      const { service } = buildService();

      const result = await service.issue(
        repo as unknown as Repository<AccountSetupToken>,
        'user-1',
        60_000,
      );

      expect(repo.create).toHaveBeenCalledWith({
        userId: 'user-1',
        tokenHash: TOKEN_HASH,
        consumedAt: null,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      // save must persist whatever create() handed back, not a fresh literal.
      expect(repo.save).toHaveBeenCalledWith(repo.create.mock.results[0].value);
      expect(result).toBe(TOKEN);
    });

    it('derives expiresAt from ClockService.now(), not the system clock', async () => {
      const repo = buildRepo();
      const { service } = buildService();

      await service.issue(repo as unknown as Repository<AccountSetupToken>, 'user-2', 5_000);

      const created = repo.create.mock.calls[0][0] as Partial<AccountSetupToken>;
      expect(created.expiresAt).toEqual(new Date(NOW.getTime() + 5_000));
    });
  });

  describe('validate', () => {
    it('hashes the plaintext token and looks the row up by tokenHash', async () => {
      const repo = buildRepo();
      repo.findOne.mockResolvedValue(row());
      const { service, tokens } = buildService();

      await service.validate(repo as unknown as Repository<AccountSetupToken>, TOKEN, MESSAGES);

      expect(tokens.hashOpaqueToken).toHaveBeenCalledWith(TOKEN);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { tokenHash: TOKEN_HASH } });
    });

    it('returns the row when it exists, is unconsumed and unexpired', async () => {
      const repo = buildRepo();
      const found = row();
      repo.findOne.mockResolvedValue(found);
      const { service } = buildService();

      const result = await service.validate(
        repo as unknown as Repository<AccountSetupToken>,
        TOKEN,
        MESSAGES,
      );

      expect(result).toBe(found);
    });

    it('rejects with UnauthorizedException/INVALID_TOKEN using messages.invalid when no row matches', async () => {
      const repo = buildRepo();
      repo.findOne.mockResolvedValue(null);
      const { service } = buildService();

      const promise = service.validate(
        repo as unknown as Repository<AccountSetupToken>,
        TOKEN,
        MESSAGES,
      );

      await expectFailure(promise, UnauthorizedException, ErrorCode.INVALID_TOKEN);
      await promise.catch((error: { getResponse: () => { message: string } }) => {
        expect(error.getResponse().message).toBe(MESSAGES.invalid);
      });
    });

    it('rejects with ConflictException/TOKEN_ALREADY_USED using messages.alreadyUsed when consumedAt is set', async () => {
      const repo = buildRepo();
      repo.findOne.mockResolvedValue(row({ consumedAt: NOW }));
      const { service } = buildService();

      const promise = service.validate(
        repo as unknown as Repository<AccountSetupToken>,
        TOKEN,
        MESSAGES,
      );

      await expectFailure(promise, ConflictException, ErrorCode.TOKEN_ALREADY_USED);
      await promise.catch((error: { getResponse: () => { message: string } }) => {
        expect(error.getResponse().message).toBe(MESSAGES.alreadyUsed);
      });
    });

    it('reports TOKEN_ALREADY_USED (not EXPIRED_TOKEN) when a row is both consumed and expired', async () => {
      // The consumed-check runs before the expiry-check, so a row that is both
      // must resolve to "already used" rather than "expired".
      const repo = buildRepo();
      repo.findOne.mockResolvedValue(
        row({
          consumedAt: new Date(NOW.getTime() - 1),
          expiresAt: new Date(NOW.getTime() - 60_000),
        }),
      );
      const { service } = buildService();

      const promise = service.validate(
        repo as unknown as Repository<AccountSetupToken>,
        TOKEN,
        MESSAGES,
      );

      await expectFailure(promise, ConflictException, ErrorCode.TOKEN_ALREADY_USED);
    });

    it('rejects with GoneException/EXPIRED_TOKEN using messages.expired when the row is unconsumed but past expiresAt', async () => {
      const repo = buildRepo();
      repo.findOne.mockResolvedValue(row({ expiresAt: new Date(NOW.getTime() - 1) }));
      const { service } = buildService();

      const promise = service.validate(
        repo as unknown as Repository<AccountSetupToken>,
        TOKEN,
        MESSAGES,
      );

      await expectFailure(promise, GoneException, ErrorCode.EXPIRED_TOKEN);
      await promise.catch((error: { getResponse: () => { message: string } }) => {
        expect(error.getResponse().message).toBe(MESSAGES.expired);
      });
    });
  });

  describe('markConsumed', () => {
    const alreadyUsed: Pick<SingleUseTokenMessages, 'alreadyUsed'> = {
      alreadyUsed: MESSAGES.alreadyUsed,
    };

    function updateResult(affected: number): UpdateResult {
      return { affected, raw: [], generatedMaps: [] };
    }

    it('updates by {id, consumedAt: IsNull()} with patch {consumedAt: now}', async () => {
      const repo = buildRepo();
      repo.update.mockResolvedValue(updateResult(1));
      const { service } = buildService();

      await service.markConsumed(
        repo as unknown as Repository<AccountSetupToken>,
        'token-1',
        NOW,
        alreadyUsed,
      );

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'token-1', consumedAt: IsNull() },
        { consumedAt: NOW },
      );
    });

    it('resolves void when exactly one row was updated (affected: 1)', async () => {
      const repo = buildRepo();
      repo.update.mockResolvedValue(updateResult(1));
      const { service } = buildService();

      await expect(
        service.markConsumed(
          repo as unknown as Repository<AccountSetupToken>,
          'token-1',
          NOW,
          alreadyUsed,
        ),
      ).resolves.toBeUndefined();
    });

    it('throws ConflictException/TOKEN_ALREADY_USED using messages.alreadyUsed when affected: 0 (lost the race to a concurrent consumer)', async () => {
      const repo = buildRepo();
      repo.update.mockResolvedValue(updateResult(0));
      const { service } = buildService();

      const promise = service.markConsumed(
        repo as unknown as Repository<AccountSetupToken>,
        'token-1',
        NOW,
        alreadyUsed,
      );

      await expectFailure(promise, ConflictException, ErrorCode.TOKEN_ALREADY_USED);
      await promise.catch((error: { getResponse: () => { message: string } }) => {
        expect(error.getResponse().message).toBe(MESSAGES.alreadyUsed);
      });
    });

    it('treats affected: undefined the same as no rows updated', async () => {
      // Some drivers omit `affected` rather than reporting 0; the guard must
      // not accidentally treat a missing count as success.
      const repo = buildRepo();
      repo.update.mockResolvedValue({ affected: undefined, raw: [], generatedMaps: [] });
      const { service } = buildService();

      const promise = service.markConsumed(
        repo as unknown as Repository<AccountSetupToken>,
        'token-1',
        NOW,
        alreadyUsed,
      );

      await expectFailure(promise, ConflictException, ErrorCode.TOKEN_ALREADY_USED);
    });
  });
});
