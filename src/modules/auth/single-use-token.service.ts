import {
  ConflictException,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { SingleUseTokenBase } from './entities/single-use-token.base';
import { TokenService } from './token.service';

export interface SingleUseTokenMessages {
  invalid: string;
  alreadyUsed: string;
  expired: string;
}

/**
 * Issue and validate opaque single-use tokens (account setup, email
 * verification, password reset) against whichever repository the caller
 * passes — one home for the hash/expiry/consumed rules the three flows share.
 * Marking a token consumed is left to the caller: some flows gate it behind a
 * further check (e.g. the account must still be usable) that must run before
 * the token is spent.
 */
@Injectable()
export class SingleUseTokenService {
  constructor(
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
  ) {}

  async issue<T extends SingleUseTokenBase>(
    repo: Repository<T>,
    userId: string,
    ttlMs: number,
  ): Promise<string> {
    const { token, tokenHash } = this.tokens.generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + ttlMs);
    const entity: DeepPartial<T> = {
      userId,
      tokenHash,
      consumedAt: null,
      expiresAt,
    } as DeepPartial<T>;
    await repo.save(repo.create(entity));
    return token;
  }

  async validate<T extends SingleUseTokenBase>(
    repo: Repository<T>,
    token: string,
    messages: SingleUseTokenMessages,
  ): Promise<T> {
    const tokenHash = this.tokens.hashOpaqueToken(token);
    const where: FindOptionsWhere<T> = { tokenHash } as FindOptionsWhere<T>;
    const row = await repo.findOne({ where });
    if (!row) {
      throw new UnauthorizedException({
        errorCode: ErrorCode.INVALID_TOKEN,
        message: messages.invalid,
      });
    }
    if (row.consumedAt) {
      throw new ConflictException({
        errorCode: ErrorCode.TOKEN_ALREADY_USED,
        message: messages.alreadyUsed,
      });
    }
    if (row.expiresAt.getTime() < this.clock.now().getTime()) {
      throw new GoneException({ errorCode: ErrorCode.EXPIRED_TOKEN, message: messages.expired });
    }
    return row;
  }

  async markConsumed<T extends SingleUseTokenBase>(
    repo: Repository<T>,
    id: string,
    now: Date,
  ): Promise<void> {
    const criteria: FindOptionsWhere<T> = { id } as FindOptionsWhere<T>;
    const patch: QueryDeepPartialEntity<T> = {
      consumedAt: now,
    } as unknown as QueryDeepPartialEntity<T>;
    await repo.update(criteria, patch);
  }
}
