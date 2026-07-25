import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsPhoneNumberLoose } from '../../../shared/validation/phone';
import { Role } from '../../users/entities/user.enums';

export class CreateTrainerDto {
  @ApiProperty({ example: 'coach@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Tess Hoops Academy' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  businessName!: string;

  // Required: the acceptance criteria list trainer name alongside business
  // name and email, and the invite email greets by first name — a nameless
  // trainer rendered as "Hi ,".
  @ApiProperty({ example: 'Tess' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Fletcher' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ example: '+1 555 123 4567' })
  @IsOptional()
  @IsPhoneNumberLoose()
  phone?: string;

  /**
   * Optional, and only ever `Trainer`. It stays in the contract because the
   * spec documents a 403 CANNOT_CREATE_SUPER_ADMIN response for this endpoint,
   * but the service now rejects every other value instead of accepting it and
   * silently creating a Trainer anyway.
   */
  @ApiPropertyOptional({ enum: Role, default: Role.Trainer })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
