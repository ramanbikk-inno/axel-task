import { Request } from 'express';

/**
 * Source IP, taking the proxy chain into account only when Express has been
 * told to trust one (see trustProxySetting) — otherwise req.ips is empty and a
 * forged X-Forwarded-For is ignored.
 */
export function clientIp(req: Request): string {
  return Array.isArray(req.ips) && req.ips.length > 0 ? req.ips[0] : (req.ip ?? 'unknown');
}

/** Per-IP bucket: catches credential stuffing and password spraying. */
export function ipTracker(req: Record<string, unknown>): string {
  return clientIp(req as unknown as Request);
}

/**
 * Per-IP-and-account bucket: catches repeated attacks on one account.
 *
 * This was the *only* bucket, which made spraying free — every new email
 * started a fresh allowance. It is still worth keeping alongside the per-IP
 * limit because it can be much tighter without penalising shared IPs.
 */
export function identityTracker(req: Record<string, unknown>): string {
  const request = req as unknown as Request;
  const body: unknown = request.body;
  const rawEmail: unknown =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['email']
      : undefined;
  const identifier: string = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  return `${clientIp(request)}|${identifier}`;
}
