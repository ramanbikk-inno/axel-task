import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { Role, UserStatus } from '../../src/modules/users/entities/user.enums';
import { User } from '../../src/modules/users/entities/user.entity';

export const FACTORY_PASSWORD = 'Str0ng!Passw0rd';

export interface CreateUserOverrides {
  email?: string;
  role?: Role;
  status?: UserStatus;
  emailVerified?: boolean;
  mustSetPassword?: boolean;
  firstName?: string;
  lastName?: string;
}

export async function createUser(
  dataSource: DataSource,
  over: CreateUserOverrides = {},
): Promise<User> {
  const passwordHash: string = await argon2.hash(FACTORY_PASSWORD, {
    type: argon2.argon2id,
  });

  const repository = dataSource.getRepository(User);
  const user: User = repository.create({
    email: over.email ?? `player-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    role: over.role ?? Role.PlayerParent,
    status: over.status ?? UserStatus.Active,
    emailVerified: over.emailVerified ?? true,
    emailVerifiedAt: (over.emailVerified ?? true) ? new Date() : null,
    mustSetPassword: over.mustSetPassword ?? false,
    passwordHash,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? 'Player',
  });

  return repository.save(user);
}
