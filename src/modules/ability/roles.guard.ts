import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles: Role[] | undefined = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles === undefined || requiredRoles.length === 0) {
      return true;
    }

    const request: Request & { user?: Principal } = context
      .switchToHttp()
      .getRequest<Request & { user?: Principal }>();
    const principal: Principal | undefined = request.user;

    if (principal === undefined) {
      throw new ForbiddenException('Insufficient role');
    }

    if (!requiredRoles.includes(principal.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
