import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ImpersonationHistoryQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only sessions run by this admin' })
  @IsOptional()
  @IsUUID('4')
  adminUserId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only sessions against this user' })
  @IsOptional()
  @IsUUID('4')
  targetUserId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ImpersonationActionView {
  @ApiProperty() action!: string;
  @ApiProperty() at!: string;
  @ApiPropertyOptional({ type: Object, nullable: true })
  metadata!: Record<string, unknown> | null;
}

export class ImpersonationHistoryEntryView {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ format: 'uuid' }) adminUserId!: string;
  @ApiPropertyOptional({ nullable: true }) adminEmail!: string | null;
  @ApiProperty({ format: 'uuid' }) targetUserId!: string;
  @ApiPropertyOptional({ nullable: true }) targetEmail!: string | null;
  @ApiProperty() startedAt!: string;
  @ApiPropertyOptional({ nullable: true }) endedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) durationSeconds!: number | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;

  /**
   * What the admin actually did while wearing the other identity. The spec
   * calls the detailed action log optional, but a history that says only "an
   * admin was signed in as this user for 40 minutes" answers nothing a
   * compliance reviewer is going to ask.
   */
  @ApiProperty({ type: [ImpersonationActionView] })
  actions!: ImpersonationActionView[];
}

export class ImpersonationHistoryView {
  @ApiProperty({ type: [ImpersonationHistoryEntryView] })
  items!: ImpersonationHistoryEntryView[];

  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
