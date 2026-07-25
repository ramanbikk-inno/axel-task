import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

const handlerRef = (): undefined => undefined;
class ClassRef {}

describe('RolesGuard', () => {
  const buildContext = (principal: Principal | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: (): { user?: Principal } => ({ user: principal }),
      }),
      getHandler: () => handlerRef,
      getClass: () => ClassRef,
    }) as unknown as ExecutionContext;

  const makePrincipal = (role: Role): Principal => ({
    userId: 'u1',
    role,
    sessionId: 's1',
    activeTrainerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    tokenVersion: 0,
    scope: role === Role.SuperAdmin ? 'platform' : 'trainer',
    impersonating: false,
  });

  it('allows the request when no @Roles metadata is present', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(buildContext(makePrincipal(Role.PlayerParent)))).toBe(true);
  });

  it('allows when the principal role is in the required set', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SuperAdmin]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(buildContext(makePrincipal(Role.SuperAdmin)))).toBe(true);
  });

  it('throws ForbiddenException when the principal role is not in the required set', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SuperAdmin]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(buildContext(makePrincipal(Role.PlayerParent)))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when there is no authenticated principal', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.SuperAdmin]),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });

  it('reads metadata from both handler and class via ROLES_KEY', () => {
    const getAllAndOverride = jest.fn().mockReturnValue([Role.Trainer]);
    const reflector = { getAllAndOverride } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const context = buildContext(makePrincipal(Role.Trainer));

    guard.canActivate(context);

    expect(getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  });
});
