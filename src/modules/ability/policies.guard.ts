import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { Principal } from '../auth/principal';
import { AbilityFactory } from './ability.factory';
import { CHECK_POLICIES_KEY, PolicyHandler } from './check-policies.decorator';

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handlers: PolicyHandler[] =
      this.reflector.getAllAndOverride<PolicyHandler[]>(CHECK_POLICIES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (handlers.length === 0) {
      return true;
    }

    const request: Request & { user?: Principal } = context
      .switchToHttp()
      .getRequest<Request & { user?: Principal }>();
    const principal: Principal | undefined = request.user;

    if (principal === undefined) {
      throw new ForbiddenException('Forbidden');
    }

    const ability = this.abilityFactory.createForPrincipal(principal);

    const allowed: boolean = handlers.every((handler) => handler(ability));
    if (!allowed) {
      throw new ForbiddenException('Forbidden');
    }

    return true;
  }
}
