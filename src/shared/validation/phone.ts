import { applyDecorators } from '@nestjs/common';
import { Matches, MaxLength } from 'class-validator';

/**
 * Spec section 9 requires phone-number format validation, but the platform is
 * not single-country, so this deliberately checks shape rather than dialling
 * plan: an optional leading +, then 7-20 digits, with spaces, hyphens, dots and
 * parentheses allowed as separators.
 *
 * `libphonenumber`-grade validation would reject legitimate international
 * numbers we have no way to confirm, and would add a dependency for a field
 * nothing dials. This rejects the cases that actually matter — free text,
 * injected markup, and truncated numbers.
 */
export const PHONE_REGEX = /^\+?(?=(?:\D*\d){7,20}\D*$)[\d\s().-]+$/;

export function IsPhoneNumberLoose(): PropertyDecorator {
  return applyDecorators(
    MaxLength(30),
    Matches(PHONE_REGEX, {
      message: 'must be a valid phone number (7-20 digits, optional + prefix)',
    }),
  );
}
