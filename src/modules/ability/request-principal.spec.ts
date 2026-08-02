import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { getPrincipalOrThrow } from './request-principal';

describe('getPrincipalOrThrow', () => {
  const principal: Principal = {
    userId: 'u1',
    role: Role.SuperAdmin,
    sessionId: 's1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: 'platform',
    impersonating: false,
  };

  const buildContext = (user: Principal | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: (): { user?: Principal } => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  it('returns the principal attached to the request', () => {
    expect(getPrincipalOrThrow(buildContext(principal), 'Forbidden')).toBe(principal);
  });

  it('throws ForbiddenException with the caller-supplied message', () => {
    expect(() => getPrincipalOrThrow(buildContext(undefined), 'Insufficient role')).toThrow(
      new ForbiddenException('Insufficient role'),
    );
  });
});
