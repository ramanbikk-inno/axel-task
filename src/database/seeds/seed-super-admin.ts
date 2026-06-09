import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { AppDataSource } from '../../shared/database/data-source';
import { PasswordService } from '../../shared/crypto/password.service';
import { User } from '../../modules/users/entities/user.entity';
import { Role, UserStatus } from '../../modules/users/entities/user.enums';

export interface SuperAdminSeedInput {
  email: string;
  password: string;
}

/**
 * Idempotently ensures exactly one SuperAdmin user exists for the given email.
 * On first run: creates the user (Active, emailVerified=true).
 * On subsequent runs: no-op (does not duplicate, does not overwrite the password).
 */
export async function upsertSuperAdmin(
  dataSource: DataSource,
  passwords: PasswordService,
  input: SuperAdminSeedInput,
): Promise<void> {
  const repository: Repository<User> = dataSource.getRepository(User);

  const existing: User | null = await repository.findOne({
    where: { email: input.email },
  });
  if (existing) {
    return;
  }

  const passwordHash: string = await passwords.hash(input.password);

  const admin: User = repository.create({
    email: input.email,
    passwordHash,
    role: Role.SuperAdmin,
    status: UserStatus.Active,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    mustSetPassword: false,
  });

  await repository.save(admin);
}

async function run(): Promise<void> {
  // Imported lazily so that importing `upsertSuperAdmin` (e.g. in tests) does not
  // eagerly trigger AppModule's env validation before dotenv has loaded.
  const { AppModule } = await import('../../app.module');
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const config: ConfigService = appContext.get(ConfigService);
    const passwords: PasswordService = appContext.get(PasswordService);

    const email: string | undefined = config.get<string>('SUPER_ADMIN_EMAIL');
    const password: string | undefined = config.get<string>('SUPER_ADMIN_PASSWORD');
    if (!email || !password) {
      throw new Error(
        'SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set to seed the SuperAdmin.',
      );
    }

    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }

    await upsertSuperAdmin(AppDataSource, passwords, { email, password });
    // eslint-disable-next-line no-console
    console.log(`SuperAdmin seed complete for ${email}.`);
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
    await appContext.close();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('SuperAdmin seed failed:', error);
      process.exit(1);
    });
}
