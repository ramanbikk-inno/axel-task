/**
 * X-Forwarded-For is trivially forged, and rate limiting keys on the IP it
 * yields. Trust nothing unless the operator declares how many proxy hops
 * actually sit in front of the app.
 */
export function trustProxySetting(raw: string | undefined): boolean | number {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') {
    return false;
  }
  const hops = Number(raw);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}
