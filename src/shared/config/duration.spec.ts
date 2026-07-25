import { durationToSeconds } from './duration';

describe('durationToSeconds', () => {
  it.each([
    ['15m', 900],
    ['7d', 604800],
    ['1h', 3600],
    ['30s', 30],
    ['3600', 3600],
    ['15 m', 900],
  ])('parses %s as %i seconds', (value: string, expected: number) => {
    expect(durationToSeconds(value)).toBe(expected);
  });

  it.each(['', 'fifteen minutes', '15w', '-5m', '1.5h', '15m30s'])(
    'throws rather than guessing at %p',
    (value: string) => {
      // A silent 0 or NaN here would mint tokens that expire immediately or
      // never, so the only safe failure is a loud one at startup.
      expect(() => durationToSeconds(value)).toThrow(/Invalid duration/);
    },
  );
});
