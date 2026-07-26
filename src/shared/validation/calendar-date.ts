import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * A calendar date with no time component: exactly YYYY-MM-DD.
 *
 * Deliberately narrower than `@IsISO8601()`, which also accepts full
 * date-times. That mattered: `birthDate` was validated with `@IsISO8601()` and
 * then parsed as `new Date(`${birthDate}T00:00:00.000Z`)`. A value like
 * `1970-01-01T00:00:00.000Z` passed validation, produced `Invalid Date` once
 * the suffix was appended, and every subsequent comparison against `NaN` was
 * false — so the 1-18 age gate on child profiles let any age through.
 */
export const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a calendar date, returning null for anything that is not a real day.
 * The round-trip catches values that are well-formed but do not exist, such as
 * 2008-02-30 or 2025-13-01, which `Date` would otherwise roll forward.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!CALENDAR_DATE_REGEX.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return roundTrips ? parsed : null;
}

/**
 * Whole years elapsed between two dates, counting a birthday that has not yet
 * come round this year as the previous age.
 *
 * Shared because two rules depend on it and must not drift apart: the 1-18
 * bound on a child profile (US-01.03) and the minimum age for holding an
 * independent account (section 9). All arithmetic is UTC, matching how
 * `parseCalendarDate` builds the date.
 */
export function ageInYears(born: Date, asOf: Date): number {
  let age = asOf.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < born.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Runs the same `parseCalendarDate` the services use, so a value that is
 * well-formed but not a real day (2008-02-30) is rejected by the validation
 * pipe as a 422 rather than falling through to a service and surfacing as a
 * 400. One rule, one status code, whichever layer you enter through.
 */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return function decorate(target: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && parseCalendarDate(value) !== null;
        },
        defaultMessage(): string {
          return 'must be a real calendar date in YYYY-MM-DD format, with no time component';
        },
      },
    });
  };
}
