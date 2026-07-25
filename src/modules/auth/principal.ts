import { Role } from '../users/entities/user.enums';

export type TenantScope = 'platform' | 'trainer';

/**
 * A SuperAdmin operates across the whole platform; every other role is confined
 * to a trainer organisation. Shared by token minting and request-time principal
 * construction so the two can never disagree.
 */
export function scopeForRole(role: Role): TenantScope {
  return role === Role.SuperAdmin ? 'platform' : 'trainer';
}

export interface Principal {
  userId: string;
  role: Role;
  sessionId: string;
  activeTrainerProfileId: string | null;
  trainerOrgId: string | null;
  tokenVersion: number;
  scope: TenantScope;
  impersonating: boolean;
  actor?: { userId: string };
}
