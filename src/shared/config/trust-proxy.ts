/**
 * Express only honours X-Forwarded-For when told to trust a proxy, and that
 * header is trivially forged by the client.
 *
 * Hard-coding `trust proxy: 1` meant a deployment exposed directly to the
 * internet would take the caller's own X-Forwarded-For as its IP — and that IP
 * is the key rate limiting buckets on, so an attacker could rotate the header
 * and never be throttled. Trust nothing unless the operator declares how many
 * proxy hops actually sit in front of the app.
 */
export function trustProxySetting(raw: string | undefined): boolean | number {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') {
    return false;
  }
  const hops = Number(raw);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}
