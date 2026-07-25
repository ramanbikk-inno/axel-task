import { trustProxySetting } from './trust-proxy';

describe('trustProxySetting', () => {
  it.each([undefined, '', 'false', '0'])(
    'does not trust X-Forwarded-For when TRUST_PROXY is %p',
    (raw?: string) => {
      expect(trustProxySetting(raw)).toBe(false);
    },
  );

  it.each([
    ['1', 1],
    ['2', 2],
  ])('trusts %s proxy hop(s)', (raw: string, expected: number) => {
    expect(trustProxySetting(raw)).toBe(expected);
  });

  it.each(['yes', 'true', '-1', '1.5', 'nginx'])(
    'refuses to trust a proxy for the unparseable value %p',
    (raw: string) => {
      expect(trustProxySetting(raw)).toBe(false);
    },
  );
});
