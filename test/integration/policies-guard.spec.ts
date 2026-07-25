import {
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { Principal } from '../../src/modules/auth/principal';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { AbilityModule } from '../../src/modules/ability/ability.module';
import { Action, AppAbility } from '../../src/modules/ability/ability.factory';
import { CheckPolicies } from '../../src/modules/ability/check-policies.decorator';
import { PoliciesGuard } from '../../src/modules/ability/policies.guard';
import { Role } from '../../src/modules/users/entities/user.enums';

@Controller('policy-probe')
class PolicyProbeController {
  @Get('create-user')
  @UseGuards(JwtAuthGuard, PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, 'User'))
  handle(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [AbilityModule], controllers: [PolicyProbeController] })
class PolicyProbeModule {}

describe('PoliciesGuard (integration via probe controller)', () => {
  let app: INestApplication;
  let currentPrincipal: Principal;

  const principal = (role: Role): Principal => ({
    userId: 'u1',
    role,
    sessionId: 's1',
    activeTrainerProfileId: null,
    activePlayerProfileId: null,
    trainerOrgId: null,
    coachProfileId: null,
    isChild: false,
    childPlayerProfileId: null,
    parentUserId: null,
    tokenVersion: 0,
    scope: role === Role.SuperAdmin ? 'platform' : 'trainer',
    impersonating: false,
  });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PolicyProbeModule],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext): boolean => {
          ctx.switchToHttp().getRequest().user = currentPrincipal;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('permits a SuperAdmin (can create User)', async () => {
    currentPrincipal = principal(Role.SuperAdmin);

    await request(app.getHttpServer())
      .get('/api/v1/policy-probe/create-user')
      .expect(200, { ok: true });
  });

  it('denies a PlayerParent (cannot create User)', async () => {
    currentPrincipal = principal(Role.PlayerParent);

    await request(app.getHttpServer()).get('/api/v1/policy-probe/create-user').expect(403);
  });
});
