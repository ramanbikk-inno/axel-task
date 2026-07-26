import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;

  /**
   * Not validated against the password policy: login checks a password, it does
   * not set one. Doing so returned 422 for a wrong password of the wrong shape
   * and 401 for the right shape, leaking the policy and breaking the guarantee
   * that every failed login looks identical. The length bound stays, to keep
   * argon2id off a megabyte of input.
   */
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
