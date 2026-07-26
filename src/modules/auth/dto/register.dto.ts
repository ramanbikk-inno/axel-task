import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';

import {
  IsStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
} from '../../../shared/validation/password';
import { IsPhoneNumberLoose } from '../../../shared/validation/phone';

export class RegisterDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;

  /**
   * Required, not optional: section 9 forbids an independent account for a
   * minor, and that cannot be enforced against a field the caller may omit.
   */
  @ApiProperty({ example: '1994-03-22', description: 'Date of birth (YYYY-MM-DD)' })
  @IsCalendarDate()
  birthDate!: string;
}
