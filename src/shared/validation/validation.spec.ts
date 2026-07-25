import { CALENDAR_DATE_REGEX, parseCalendarDate } from './calendar-date';
import { PHONE_REGEX } from './phone';

describe('parseCalendarDate', () => {
  it('accepts a plain calendar date', () => {
    expect(parseCalendarDate('2014-08-01')?.toISOString()).toBe('2014-08-01T00:00:00.000Z');
  });

  it.each([
    // The bug this exists to prevent: @IsISO8601() accepted all of these, and
    // appending 'T00:00:00.000Z' to them produced Invalid Date -> NaN age ->
    // every age comparison false -> the 1-18 child gate passed anything.
    '1970-01-01T00:00:00.000Z',
    '1930-01-01T12:00:00Z',
    '2014-08-01T00:00',
    '20140801',
  ])('rejects the date-time form %s', (value: string) => {
    expect(parseCalendarDate(value)).toBeNull();
    expect(CALENDAR_DATE_REGEX.test(value)).toBe(false);
  });

  it.each([
    ['2008-02-30', 'a day February never has'],
    ['2025-13-01', 'a thirteenth month'],
    ['2025-00-10', 'a zeroth month'],
    ['2025-06-31', 'a June 31st'],
  ])('rejects %s (%s) instead of rolling it forward', (value: string) => {
    // new Date('2008-02-30') silently becomes March 1st; the round-trip check
    // is what catches it.
    expect(parseCalendarDate(value)).toBeNull();
  });

  it('accepts a real leap day and rejects one in a non-leap year', () => {
    expect(parseCalendarDate('2024-02-29')).not.toBeNull();
    expect(parseCalendarDate('2023-02-29')).toBeNull();
  });

  it.each(['', 'not-a-date', '2014-8-1', '  2014-08-01  '])(
    'rejects malformed input %p',
    (value: string) => {
      expect(parseCalendarDate(value)).toBeNull();
    },
  );
});

describe('PHONE_REGEX', () => {
  it.each(['+1 555 123 4567', '(555) 123-4567', '5551234567', '+44 20 7946 0958', '555.123.4567'])(
    'accepts %s',
    (value: string) => {
      expect(PHONE_REGEX.test(value)).toBe(true);
    },
  );

  it.each([
    ['', 'empty'],
    ['abc', 'letters'],
    ['123', 'too few digits'],
    ['<script>alert(1)</script>', 'markup'],
    ['+1 555 123 4567 ext 99', 'trailing free text'],
    ['12345678901234567890123', 'too many digits'],
  ])('rejects %p (%s)', (value: string) => {
    expect(PHONE_REGEX.test(value)).toBe(false);
  });
});
