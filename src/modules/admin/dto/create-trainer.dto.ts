import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
