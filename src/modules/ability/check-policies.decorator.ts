import { SetMetadata } from '@nestjs/common';

import { AppAbility } from './ability.factory';

export type PolicyHandler = (ability: AppAbility) => boolean;

export const CHECK_POLICIES_KEY = 'check_policies';

export const CheckPolicies = (...handlers: PolicyHandler[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CHECK_POLICIES_KEY, handlers);
