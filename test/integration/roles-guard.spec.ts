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
import { Roles } from '../../src/modules/ability/roles.decorator';
import { RolesGuard } from '../../src/modules/ability/roles.guard';
import { Role } from '../../src/modules/users/entities/user.enums';

@Controller('admin-only')
class AdminOnlyController {
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  handle(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AdminOnlyController], providers: [RolesGuard] })
class AdminOnlyModule {}

describe('RolesGuard (integration via probe controller)', () => {
  let app: INestApplication;
  let currentPrincipal: Principal;

  const principal = (role: Role): Principal => ({
    userId: 'u1',
    role,
    sessionId: 's1',
    activeTrainerProfileId: null,
    trainerOrgId: null,
    tokenVersion: 0,
    scope: role === Role.SuperAdmin ? 'platform' : 'trainer',
    impersonating: false,
  });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AdminOnlyModule] })
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

  it('returns 200 for a SuperAdmin on a SuperAdmin-guarded route', async () => {
    currentPrincipal = principal(Role.SuperAdmin);

    await request(app.getHttpServer()).get('/api/v1/admin-only').expect(200, { ok: true });
  });

  it('returns 403 for a PlayerParent on a SuperAdmin-guarded route', async () => {
    currentPrincipal = principal(Role.PlayerParent);

    await request(app.getHttpServer()).get('/api/v1/admin-only').expect(403);
  });
});
