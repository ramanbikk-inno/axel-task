import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UserStatusChangeDto {
  @ApiPropertyOptional({ description: 'Optional reason recorded in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
