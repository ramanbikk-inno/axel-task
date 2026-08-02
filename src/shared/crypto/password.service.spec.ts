import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { CryptoModule } from './crypto.module';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            (): Record<string, string> => ({
              ARGON_MEMORY_KIB: '19456',
              ARGON_TIME_COST: '2',
              ARGON_PARALLELISM: '1',
            }),
          ],
        }),
        CryptoModule,
      ],
    }).compile();

    service = moduleRef.get<PasswordService>(PasswordService);
  });

  it('produces a hash that differs from the plaintext', async () => {
    const plain = 'Str0ng!Passw0rd';
    const hash: string = await service.hash(plain);
    expect(hash).not.toBe(plain);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verify() returns true for the correct password', async () => {
    const plain = 'Str0ng!Passw0rd';
    const hash: string = await service.hash(plain);
    await expect(service.verify(hash, plain)).resolves.toBe(true);
  });

  it('verify() returns false for a wrong password', async () => {
    const hash: string = await service.hash('Str0ng!Passw0rd');
    await expect(service.verify(hash, 'wrong-password-123!')).resolves.toBe(false);
  });

  it('needsRehash() is false for a hash made with the current parameters', async () => {
    const hash: string = await service.hash('Str0ng!Passw0rd');
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('needsRehash() is true for a hash made with weaker parameters', async () => {
    const weakHash: string = await argon2.hash('Str0ng!Passw0rd', {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    expect(service.needsRehash(weakHash)).toBe(true);
  });
});
