import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../../shared/dto/pagination.query.dto';
import { Role, UserStatus } from '../../users/entities/user.enums';

/**
 * Query params for the Super Admin Users directory. Search is
 * tool-specific (email/first/last name) rather than global.
 */
export class ListUsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Substring match on email, first name or last name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
