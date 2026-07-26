import { applyDecorators } from '@nestjs/common';
import { Matches, MaxLength } from 'class-validator';

/**
 * Shape, not dialling plan: an optional leading +, then 7-20 digits, with
 * spaces, hyphens, dots and parentheses as separators. `libphonenumber` would
 * reject legitimate international numbers for a field nothing dials. This
 * catches what matters — free text, injected markup, truncated numbers.
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
