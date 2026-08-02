import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';
import { IsPhoneNumberLoose } from '../../../shared/validation/phone';

/**
 * Registration payload for joining a trainer via a ShareLink.
 * Creates the account holder's own player profile.
 */
export class JoinRegisterDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/, {
    message: 'password must contain upper, lower, number and symbol',
  })
  password!: string;

  /** Required for the same reason as on /auth/register. */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

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

  @ApiPropertyOptional({ example: 'female' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string;

  /**
   * Required for the same reason as on /auth/register, and narrowed from
   * IsISO8601 to a bare calendar date so a value carrying a time component
   * cannot reach the age arithmetic.
   */
  @ApiProperty({ example: '1994-03-22', description: 'Date of birth (YYYY-MM-DD)' })
  @IsCalendarDate()
  birthDate!: string;
}
