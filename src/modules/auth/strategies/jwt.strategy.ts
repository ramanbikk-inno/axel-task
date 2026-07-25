import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AccessClaims } from '../auth.types';
import { Principal, scopeForRole } from '../principal';
import { SessionValidatorService, ValidatedSession } from '../session-validator.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly sessionValidator: SessionValidatorService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Claims are only a hint. Role, tenant context and impersonation state are all
   * read back from the session and user rows so that a token minted before a
   * change cannot keep asserting the stale value.
   */
  async validate(payload: AccessClaims): Promise<Principal> {
    const { session, user, trainerOrgId, coachProfileId }: ValidatedSession =
      await this.sessionValidator.validate(payload);

    const principal: Principal = {
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      activeTrainerProfileId: session.activeTrainerProfileId,
      trainerOrgId,
      coachProfileId,
      tokenVersion: user.tokenVersion,
      scope: scopeForRole(user.role),
      impersonating: session.impersonatedBy !== null,
    };
    if (session.impersonatedBy !== null) {
      principal.actor = { userId: session.impersonatedBy };
    }
    return principal;
  }
}
