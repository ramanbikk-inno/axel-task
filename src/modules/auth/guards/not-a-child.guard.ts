import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { ErrorCode } from '../../../shared/errors/error-codes';
import { Principal } from '../principal';

/**
 * Blocks child accounts from the family-management endpoints. A child shares the
 * PlayerParent role, so `@Roles(Role.PlayerParent)` admits them by construction.
 * AbilityFactory says the same thing, but these routes check ownership in the
 * service rather than through PoliciesGuard, so this is what actually runs.
 */
@Injectable()
export class NotAChildGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.user as Principal | undefined;

    // Fail closed: no principal means JwtAuthGuard has not run, and this guard
    // must never be the reason an unauthenticated request gets through.
    if (!principal || principal.isChild) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CHILD_ACTION_NOT_ALLOWED,
        message: 'Ask your parent to do this for you.',
      });
    }
    return true;
  }
}
