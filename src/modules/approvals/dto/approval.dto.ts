import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { ApprovalStatus, PaymentType } from '../entities/purchase-approval.entity';

export class RequestPurchaseDto {
  @ApiProperty({ format: 'uuid', description: 'The event the child wants to attend.' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ enum: PaymentType })
  @IsEnum(PaymentType)
  paymentType!: PaymentType;
}

export class RespondToApprovalDto {
  @ApiPropertyOptional({ description: 'Optional note the child will see with the decision.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  notes?: string;
}

export class PurchaseApprovalView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) childPlayerProfileId!: string;
  @ApiProperty() childDisplayName!: string;
  @ApiProperty({ format: 'uuid' }) parentUserId!: string;
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty() eventTitle!: string;
  @ApiProperty() eventStartsAt!: Date;
  @ApiProperty({ description: 'Minor units for USD, whole tokens for the token path.' })
  amount!: number;
  @ApiProperty({ enum: PaymentType }) paymentType!: PaymentType;
  @ApiProperty({ enum: ApprovalStatus }) status!: ApprovalStatus;
  @ApiProperty({ nullable: true }) parentNotes!: string | null;
  @ApiProperty() requestedAt!: Date;
  @ApiProperty({ nullable: true }) respondedAt!: Date | null;
  @ApiProperty() expiresAt!: Date;
  /**
   * True when the request went straight through on the parent's standing
   * permission rather than waiting — the parent is told, not asked.
   */
  @ApiProperty() autoApproved!: boolean;
}
