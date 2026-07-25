import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { ErrorCode } from '../../../shared/errors/error-codes';
import { Principal } from '../principal';

/**
 * Blocks child accounts from the family-management endpoints (US-01.06).
 *
 * A child shares the PlayerParent role, so `@Roles(Role.PlayerParent)` lets
 * them through by construction. The CASL rules in AbilityFactory say the same
 * thing, but most of these endpoints do their ownership checks in the service
 * rather than through PoliciesGuard, so this is the check that actually runs
 * on the request path today. Both are kept: a route that later gains a
 * `@CheckPolicies` should not be the first place anyone notices the guard was
 * the only thing holding.
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
