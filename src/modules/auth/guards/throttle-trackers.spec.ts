import { Request } from 'express';

import { identityTracker, ipTracker } from './throttle-trackers';

function req(over: { ips?: string[]; ip?: string; email?: string }): Record<string, unknown> {
  return {
    ips: over.ips ?? [],
    ip: over.ip ?? '10.0.0.1',
    body: over.email === undefined ? {} : { email: over.email },
  } as unknown as Request as unknown as Record<string, unknown>;
}

describe('throttle trackers', () => {
  describe('ipTracker', () => {
    it('prefers the proxy-resolved IP', () => {
      expect(ipTracker(req({ ips: ['203.0.113.7'] }))).toBe('203.0.113.7');
    });

    it('falls back to req.ip when there is no trusted proxy chain', () => {
      expect(ipTracker(req({ ips: [], ip: '10.0.0.9' }))).toBe('10.0.0.9');
    });

    it('puts every account attacked from one IP in the same bucket', () => {
      const trackers = [
        ipTracker(req({ ips: ['203.0.113.9'], email: 'victim1@example.com' })),
        ipTracker(req({ ips: ['203.0.113.9'], email: 'victim2@example.com' })),
        ipTracker(req({ ips: ['203.0.113.9'], email: 'victim3@example.com' })),
      ];

      expect(new Set(trackers).size).toBe(1);
    });
  });

  describe('identityTracker', () => {
    it('keys on IP and the normalised email', () => {
      expect(identityTracker(req({ ips: ['203.0.113.7'], email: 'User@Example.com' }))).toBe(
        '203.0.113.7|user@example.com',
      );
    });

    it('keys on IP alone when the body carries no email', () => {
      expect(identityTracker(req({ ips: ['203.0.113.7'] }))).toBe('203.0.113.7|');
    });

    it('gives each attacked account its own bucket — which is why it cannot catch spraying alone', () => {
      const a = identityTracker(req({ ips: ['203.0.113.9'], email: 'victim1@example.com' }));
      const b = identityTracker(req({ ips: ['203.0.113.9'], email: 'victim2@example.com' }));

      expect(a).not.toBe(b);
    });

    it('does not let one IP burn another IP’s allowance for the same account', () => {
      const a = identityTracker(req({ ips: ['203.0.113.1'], email: 'victim@example.com' }));
      const b = identityTracker(req({ ips: ['203.0.113.2'], email: 'victim@example.com' }));

      expect(a).not.toBe(b);
    });
  });
});
