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
  /** The selected context pair, read from the session row on every request. */
  activeTrainerProfileId: string | null;
  activePlayerProfileId: string | null;
  trainerOrgId: string | null;
  /** Set only for Coach accounts; the row availability and profile rules key on. */
  coachProfileId: string | null;
  /**
   * A child account is a PlayerParent whose login is attached to a child
   * profile (US-01.06). It is deliberately not a separate Role: the spec lists
   * four roles and a child is a Player, not a fifth kind of user. What differs
   * is the permission set, which keys on these three fields.
   *
   * Derived from `player_profiles.child_user_id` on every request, never from
   * a claim, so revoking a child login takes effect immediately.
   */
  isChild: boolean;
  /** The profile this login *is*, for a child. Null for everyone else. */
  childPlayerProfileId: string | null;
  /** The account that owns that profile, so a child can never reach past it. */
  parentUserId: string | null;
  tokenVersion: number;
  scope: TenantScope;
  impersonating: boolean;
  actor?: { userId: string };
}
