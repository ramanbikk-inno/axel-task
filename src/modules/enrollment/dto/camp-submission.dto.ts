import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsCalendarDate } from '../../../shared/validation/calendar-date';
import { IsPhoneNumberLoose } from '../../../shared/validation/phone';
import {
  IsStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_DESCRIPTION,
} from '../../../shared/validation/password';

/** The camp / evaluation form itself. Public: the submitter has no account yet. */
export class CreateCampSubmissionDto {
  @ApiProperty({ example: 'Jamie' })
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

  @ApiProperty({ example: 'jamie@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;

  @ApiPropertyOptional({ description: 'The player the form is about, if not the submitter.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  playerName?: string;

  @ApiPropertyOptional({ example: '2014-08-01' })
  @IsOptional()
  @IsCalendarDate()
  birthDate?: string;

  @ApiPropertyOptional({ example: 'female' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string;
}

/**
 * Everything the registration form can pre-fill, plus who it is with. No
 * password and no account state: this is readable by anyone holding the token.
 */
export class CampSubmissionPrefillView {
  @ApiProperty() token!: string;
  @ApiProperty({ format: 'uuid' }) trainerProfileId!: string;
  @ApiProperty() trainerName!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty({ nullable: true }) lastName!: string | null;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) playerName!: string | null;
  @ApiProperty({ nullable: true }) birthDate!: string | null;
  @ApiProperty({ nullable: true }) gender!: string | null;
  @ApiProperty({ description: 'Already became an account; the link is spent.' })
  converted!: boolean;
}

/** The trainer's view: contact details plus whether they ever signed up. */
export class CampSubmissionView extends CampSubmissionPrefillView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() submittedAt!: Date;
  @ApiProperty({ nullable: true }) convertedAt!: Date | null;
  @ApiProperty({ nullable: true }) shareLinkSentAt!: Date | null;
}

/**
 * Finish the conversion. Only the password is required — everything else
 * defaults to what the form already captured, which is the point of the flow.
 */
export class ConvertCampSubmissionDto {
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: PASSWORD_POLICY_DESCRIPTION,
  })
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ description: 'Overrides the submitted first name.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ description: 'Overrides the submitted last name.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Overrides the submitted phone number.' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Required only when the form did not capture a birth date.',
  })
  @IsOptional()
  @IsCalendarDate()
  birthDate?: string;
}
