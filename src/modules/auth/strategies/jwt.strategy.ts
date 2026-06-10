import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AccessClaims } from '../auth.types';
import { Principal } from '../principal';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: AccessClaims): Principal {
    const principal: Principal = {
      userId: payload.sub,
      role: payload.role,
      sessionId: payload.sessionId,
      activeTrainerProfileId: payload.tenant.activeTrainerProfileId,
      trainerOrgId: payload.tenant.trainerOrgId,
      tokenVersion: payload.tokenVersion,
      scope: payload.tenant.scope,
      impersonating: Boolean(payload.act),
    };
    if (payload.act) {
      principal.actor = { userId: payload.act.sub };
    }
    return principal;
  }
}
