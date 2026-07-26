import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * A calendar date with no time component: exactly YYYY-MM-DD. Narrower than
 * `@IsISO8601()`, which also accepts date-times — appending `T00:00:00.000Z` to
 * one of those yields Invalid Date, and every age comparison against NaN is
 * false, so the 1-18 gate let anything through.
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
 * Whole years elapsed, counting a birthday still to come this year as the
 * previous age. Shared by the 1-18 child bound and the self-registration floor
 * so the two cannot drift apart. UTC throughout, like `parseCalendarDate`.
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
