import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * The account password policy, in one place.
 *
 * It was previously copy-pasted across register, change-password,
 * reset-password and setup-password — and, wrongly, onto *login*, where
 * rejecting a badly-shaped password told an unauthenticated caller what the
 * policy was and returned 422 instead of the generic 401.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * argon2id is deliberately expensive, so the length of what we are willing to
 * hash is a denial-of-service parameter, not a style choice. Enforced on
 * *every* password field including login, where the rest of the policy is not.
 */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_COMPLEXITY_REGEX = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/;

export const PASSWORD_POLICY_DESCRIPTION = `Password: ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} chars, with upper, lower, number and symbol.`;

/** For fields that set a new password. Never for the one being checked at login. */
export function IsStrongPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH),
    MaxLength(PASSWORD_MAX_LENGTH),
    Matches(PASSWORD_COMPLEXITY_REGEX, {
      message: 'password must contain upper, lower, number and symbol',
    }),
  );
}
