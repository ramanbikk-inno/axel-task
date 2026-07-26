import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];

export class UpdateBrandingDto {
  /**
   * Null resets to the platform default. The logo already had
   * DELETE /trainers/me/logo; the colour had no way back.
   */
  @ApiProperty({
    example: '#1e88e5',
    nullable: true,
    description: 'Primary brand color as a hex code, or null to reset to the default',
  })
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'primaryColor must be a hex color like #1e88e5',
  })
  primaryColor!: string | null;
}

export class UploadLogoDto {
  @ApiProperty({ example: 'logo.png' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fileName!: string;

  @ApiProperty({ enum: LOGO_TYPES })
  @IsIn(LOGO_TYPES)
  mimeType!: string;

  @ApiProperty({ description: 'Base64-encoded logo (PNG/JPG/SVG, max 2MB decoded)' })
  @IsString()
  @MinLength(1)
  dataBase64!: string;
}

export class BrandingView {
  @ApiProperty() trainerProfileId!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty({ nullable: true }) logoUrl!: string | null;
  @ApiProperty({ nullable: true }) primaryColor!: string | null;
}
