import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SetupPasswordDto {
  @ApiProperty({ description: 'The opaque 72h account-setup token from the invite email.' })
  @IsString()
  token!: string;

  @ApiProperty({ description: 'New password: 12-128 chars, upper/lower/number/symbol.' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/, {
    message: 'newPassword must contain upper- and lower-case letters, a number and a symbol',
  })
  newPassword!: string;
}
