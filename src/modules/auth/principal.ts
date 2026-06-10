import { Role } from '../users/entities/user.enums';

export type TenantScope = 'platform' | 'trainer';

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
