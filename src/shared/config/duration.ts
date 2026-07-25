const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Parse a `jsonwebtoken`-style duration ("15m", "7d", "3600") into seconds.
 *
 * The TTLs are configured as those strings because that is what `expiresIn`
 * takes, but the token endpoints must also report `expiresIn` as a number. The
 * two used to be independent literals — `JWT_ACCESS_TTL` and a hard-coded
 * `ACCESS_TTL_SECONDS = 900` in three separate files — so changing the
 * configured TTL silently made every advertised expiry a lie.
 */
export function durationToSeconds(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}": expected a number optionally suffixed s, m, h, d`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  return amount * UNIT_SECONDS[unit];
}
