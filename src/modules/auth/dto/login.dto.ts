import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email!: string;

  /**
   * Deliberately *not* validated against the password policy.
   *
   * Login checks a password, it does not set one. Applying the complexity rules
   * here meant a wrong password of the wrong shape produced a 422 quoting the
   * policy, while a wrong password of the right shape produced a 401 — which
   * both leaks the policy to an unauthenticated caller and breaks the
   * enumeration-safe contract that every failed login looks identical.
   *
   * The length bound stays: it is what keeps an attacker from making us run
   * argon2id over a megabyte of input.
   */
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
