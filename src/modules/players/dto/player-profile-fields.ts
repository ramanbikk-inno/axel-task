import { EmergencyContact, PlayerProfile } from '../entities/player-profile.entity';

/**
 * The player-profile columns every API view exposes. Single source of truth:
 * three views hand-copied this list and two columns went missing on the way —
 * `allowChildTokenSpendNoApproval` never reached the self view, `photoUrl` never
 * reached the admin one. Add a column here and every view gains it.
 *
 * `ownerUserId`, `childUserId` and `photoPublicId` are deliberately out: they are
 * not part of the shared shape, and a view that wants one declares it itself.
 */
export interface PlayerProfileFields {
  id: string;
  displayName: string;
  isChild: boolean;
  birthDate: string | null;
  gender: string | null;
  school: string | null;
  jerseyNumber: string | null;
  /** Set by the trainer, read-only on every view. */
  skillLevel: string | null;
  emergencyContact: EmergencyContact | null;
  /** Only ever set for a child profile; an account holder's own is users.photoUrl. */
  photoUrl: string | null;
  /** Only meaningful for a child profile. Default OFF. */
  allowChildTokenSpendNoApproval: boolean;
}

/**
 * Spread into a view and add its extras, overriding any field it computes:
 *
 *   return { ...toPlayerProfileFields(profile), trainers };
 *   return { ...toPlayerProfileFields(player), isChild: player.childUserId === user.id };
 *
 * The view still declares its own properties and Swagger decorators; this only
 * fixes which fields it must declare.
 */
export function toPlayerProfileFields(profile: PlayerProfile): PlayerProfileFields {
  return {
    id: profile.id,
    displayName: profile.displayName,
    isChild: profile.isChild,
    birthDate: profile.birthDate,
    gender: profile.gender,
    school: profile.school,
    jerseyNumber: profile.jerseyNumber,
    skillLevel: profile.skillLevel,
    emergencyContact: profile.emergencyContact,
    photoUrl: profile.photoUrl,
    allowChildTokenSpendNoApproval: profile.allowChildTokenSpendNoApproval,
  };
}
