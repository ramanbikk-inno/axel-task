import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';

import { Principal } from '../auth/principal';

/** Reads the authenticated principal off the request; the message is the guard's own. */
export function getPrincipalOrThrow(context: ExecutionContext, message: string): Principal {
  const request: Request & { user?: Principal } = context
    .switchToHttp()
    .getRequest<Request & { user?: Principal }>();
  const principal: Principal | undefined = request.user;

  if (principal === undefined) {
    throw new ForbiddenException(message);
  }

  return principal;
}
