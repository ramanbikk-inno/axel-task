import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ImpersonateDto {
  @ApiPropertyOptional({ description: 'Optional reason recorded in the impersonation audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
