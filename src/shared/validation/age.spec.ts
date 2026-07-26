import { ageInYears, parseCalendarDate } from './calendar-date';

const at = (iso: string): Date => parseCalendarDate(iso) as Date;

/**
 * Two rules depend on this arithmetic and must not drift apart: the 1-18 bound
 * on a child profile and the minimum age for an independent account
 *. The boundary days are the whole point — an off-by-one here is
 * the difference between admitting and refusing a minor.
 */
describe('ageInYears', () => {
  it('counts a birthday that has already passed this year', () => {
    expect(ageInYears(at('2000-03-01'), at('2026-07-26'))).toBe(26);
  });

  it('does not count a birthday still to come this year', () => {
    expect(ageInYears(at('2000-12-01'), at('2026-07-26'))).toBe(25);
  });

  it('turns over exactly on the birthday, not the day before', () => {
    const born = at('2008-07-26');
    expect(ageInYears(born, at('2026-07-25'))).toBe(17);
    expect(ageInYears(born, at('2026-07-26'))).toBe(18);
  });

  it('handles a 29 February birthday in a non-leap year', () => {
    // Born on a day that does not exist in 2026; the count still turns over on
    // 1 March, because 29 Feb has not "passed" on 28 Feb.
    const born = at('2008-02-29');
    expect(ageInYears(born, at('2026-02-28'))).toBe(17);
    expect(ageInYears(born, at('2026-03-01'))).toBe(18);
  });

  it('returns 0 on the day of birth', () => {
    expect(ageInYears(at('2026-07-26'), at('2026-07-26'))).toBe(0);
  });

  it('goes negative for a future date, so callers can reject it explicitly', () => {
    // Deliberately not clamped: a future birth date is a validation error, and
    // silently reporting it as age 0 would let it pass a `>= 0` check.
    expect(ageInYears(at('2027-01-01'), at('2026-07-26'))).toBeLessThan(0);
  });
});
