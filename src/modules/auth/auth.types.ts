import { Role } from '../users/entities/user.enums';
import { TenantScope } from './principal';

export type { TenantScope } from './principal';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AccessClaims {
  sub: string;
  role: Role;
  sessionId: string;
  tenant: {
    activeTrainerProfileId: string | null;
    trainerOrgId: string | null;
    scope: TenantScope;
  };
  tokenVersion: number;
  act?: { sub: string };
  iat?: number;
  exp?: number;
  jti?: string;
  iss?: string;
  aud?: string;
}

export interface RefreshClaims {
  sub: string;
  sessionId: string;
  jti: string;
  familyId: string;
  iat?: number;
  exp?: number;
}
