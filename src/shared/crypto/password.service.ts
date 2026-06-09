import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

export interface Argon2Options {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

@Injectable()
export class PasswordService {
  private readonly options: Argon2Options;

  constructor(private readonly config: ConfigService) {
    this.options = {
      memoryCost: Number(this.config.get('ARGON_MEMORY_KIB', 19456)),
      timeCost: Number(this.config.get('ARGON_TIME_COST', 2)),
      parallelism: Number(this.config.get('ARGON_PARALLELISM', 1)),
    };
  }

  async hash(plain: string): Promise<string> {
    return this.hashWith(plain, this.options);
  }

  async hashWith(plain: string, options: Argon2Options): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: options.memoryCost,
      timeCost: options.timeCost,
      parallelism: options.parallelism,
    });
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
