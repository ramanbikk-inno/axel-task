import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Add a profile to a trainer the parent is already associated with. */
export class AddTrainerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  trainerProfileId!: string;
}

/** Add a profile to a trainer via a ShareLink code (a new trainer). */
export class AddTrainerByCodeDto {
  @ApiProperty({ example: 'r83nZq1kd0Ab' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;
}
