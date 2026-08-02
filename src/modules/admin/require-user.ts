import { NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../shared/errors/error-codes';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';

/** The 404 every admin route answers for an unknown user id. */
export async function requireUser(usersService: UsersService, id: string): Promise<User> {
  const user = await usersService.findById(id);
  if (!user) {
    throw new NotFoundException({ errorCode: ErrorCode.NOT_FOUND, message: 'User not found.' });
  }
  return user;
}
