import { ValidateIf, ValidationOptions } from 'class-validator';

/**
 * Optional in the sense a PATCH means it: the key may be omitted, but if it is
 * present it must be valid — and `null` is not valid.
 *
 * `@IsOptional()` cannot express this. It skips every other validator when the
 * value is `null` *or* `undefined`, which is right for a genuinely nullable
 * field (where null is how a caller clears it) and wrong for every other one:
 * an explicit null sails past `@IsString()` and reaches the column, so a field
 * the entity declares NOT NULL fails in the database as a 500 instead of at the
 * validation pipe as a 422.
 *
 * Use `@IsOptional()` when null is a meaningful value for the field, and this
 * when it is not.
 */
export function IsOptionalNotNull(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined, options);
}
