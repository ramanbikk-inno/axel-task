import { ValidateIf, ValidationOptions } from 'class-validator';

/**
 * Optional in the sense a PATCH means it: the key may be omitted, but if present
 * it must be valid — and `null` is not.
 *
 * `@IsOptional()` skips every other validator on null as well as undefined, so
 * an explicit null reaches a NOT NULL column and fails as a 500. Use that one
 * where null is how a caller clears the field, and this one where it is not.
 */
export function IsOptionalNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined, options);
}
