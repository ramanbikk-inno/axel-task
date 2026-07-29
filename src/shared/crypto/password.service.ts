import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  private readonly options: argon2.Options;

  constructor(private readonly config: ConfigService) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: Number(this.config.get('ARGON_MEMORY_KIB', 19456)),
      timeCost: Number(this.config.get('ARGON_TIME_COST', 2)),
      parallelism: Number(this.config.get('ARGON_PARALLELISM', 1)),
    };
  }

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  /**
   * @deprecated Test-only shim: the e2e suite forges a weakly-parameterised
   * hash through it. Call argon2.hash directly there and drop this.
   */
  async hashWith(
    plain: string,
    options: { memoryCost: number; timeCost: number; parallelism: number },
  ): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id, ...options });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, {
      memoryCost: this.options.memoryCost,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }
}
