/**
 * "Warn if similar name/age exists" (US-01.03). Exact name+birth-date is the
 * only pair the create route refuses; everything else here is advisory, for the
 * parent to look at before submitting.
 */

export interface ChildLike {
  id: string;
  displayName: string;
  birthDate: string | null;
}

export interface SimilarChild {
  profileId: string;
  displayName: string;
  birthDate: string | null;
  /** Same normalised name and the same birth date — what the 409 keys on. */
  exact: boolean;
}

/** A calendar day either side covers a year of "close enough" birth dates. */
const MAX_BIRTH_DATE_GAP_MS = 366 * 24 * 60 * 60 * 1000;

/** Shortest prefix worth matching on: "Al" would catch half a roster. */
const MIN_NICKNAME_LENGTH = 3;

export const normalizeChildName = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

function tokensLookAlike(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_NICKNAME_LENGTH && longer.startsWith(shorter);
}

/**
 * Catches nicknames — "Alex Smith" against "Alexander Smith" — not arbitrary
 * substrings. Compared token by token, because a whole-string prefix test
 * misses exactly the case worth catching: the surname follows the given name,
 * so "alex smith" is not a prefix of "alexander smith".
 */
function namesLookAlike(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const left = a.split(' ');
  const right = b.split(' ');
  if (left.length !== right.length) {
    return false;
  }
  return left.every((token, i) => tokensLookAlike(token, right[i]));
}

function datesLookAlike(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    // One unknown birth date is not evidence either way; the name alone decides.
    return true;
  }
  const gap = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isFinite(gap) && gap <= MAX_BIRTH_DATE_GAP_MS;
}

/**
 * Existing children that look like the one being added. `excludeProfileId` keeps
 * a rename from matching the profile doing the renaming.
 */
export function findSimilarChildren(
  existing: ChildLike[],
  candidate: { displayName: string; birthDate: string | null },
  excludeProfileId?: string,
): SimilarChild[] {
  const name = normalizeChildName(candidate.displayName);

  return existing
    .filter((child) => child.id !== excludeProfileId)
    .map((child) => {
      const otherName = normalizeChildName(child.displayName);
      return {
        profileId: child.id,
        displayName: child.displayName,
        birthDate: child.birthDate,
        exact: otherName === name && child.birthDate === candidate.birthDate,
        looksAlike:
          namesLookAlike(name, otherName) && datesLookAlike(child.birthDate, candidate.birthDate),
      };
    })
    .filter((match) => match.looksAlike)
    .map(({ looksAlike: _looksAlike, ...match }) => match);
}
