import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import {
  IsStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
} from '../../../shared/validation/password';

/**
 * The parent creates the child's credentials directly rather than emailing a
 * setup link: a child young enough to need a supervised account is often
 * younger than their own mailbox, and the parent is the one who will hand the
 * password over. The account is created already verified because the parent
 * vouching for it *is* the verification.
 */
export class CreateChildLoginDto {
  @ApiProperty({ example: 'alex.family@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsStrongPassword()
  password!: string;
}

export class ChildLoginView {
  @ApiProperty({ format: 'uuid' }) playerProfileId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ format: 'uuid' }) childUserId!: string;
  @ApiProperty() email!: string;
}

export class ChildLoginStatusView {
  @ApiProperty() hasLogin!: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  childUserId?: string;

  @ApiPropertyOptional()
  email?: string;
}
