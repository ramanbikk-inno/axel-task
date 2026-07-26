import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Deactivate / reactivate: the reason is useful but not contractually required. */
export class UserStatusChangeDto {
  @ApiPropertyOptional({ description: 'Optional reason recorded in the audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * GDPR deletion is irreversible and the spec makes the reason mandatory, so it
 * gets its own DTO rather than sharing the optional-reason one. Trimmed first
 * so a whitespace-only reason fails here instead of being written to the
 * permanent record.
 */
export class DeleteUserDto {
  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Required' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
