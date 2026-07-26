import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadApiOptions, UploadApiResponse, v2 as cloudinary } from 'cloudinary';

import { ErrorCode } from '../../shared/errors/error-codes';

export const STORAGE = Symbol('STORAGE');

export interface StorageUploadInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  folder?: string;
}

export interface StorageUploadResult {
  url: string;
  publicId: string;
}

export interface StorageService {
  upload(input: StorageUploadInput): Promise<StorageUploadResult>;
  delete(publicId: string): Promise<void>;
}

/**
 * Longest edge kept for stored images. Oversized uploads are resized rather than
 * rejected; `limit` only ever scales down, so smaller images are untouched.
 */
export const MAX_EDGE_PX = 512;

@Injectable()
export class CloudinaryStorageService implements StorageService {
  private readonly logger = new Logger(CloudinaryStorageService.name);
  private readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('CLOUDINARY_URL') ?? '';
    this.configured = url !== '';
    if (this.configured) {
      // The SDK picks CLOUDINARY_URL up from the environment itself; `secure`
      // keeps delivery URLs on https.
      cloudinary.config({ secure: true });
    } else {
      this.logger.warn(
        'CLOUDINARY_URL is not set — image uploads will be rejected until it is configured.',
      );
    }
  }

  async upload(input: StorageUploadInput): Promise<StorageUploadResult> {
    if (!this.configured) {
      // This used to return a fabricated res.cloudinary.com/stub/... URL, so
      // every avatar and logo upload reported success while storing nothing
      // and persisting a dead URL. Failing loudly is the point.
      throw new InternalServerErrorException({
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: 'File storage is not configured.',
      });
    }

    const options: UploadApiOptions = {
      folder: input.folder ?? 'uploads',
      resource_type: 'image',
      transformation: [
        { width: MAX_EDGE_PX, height: MAX_EDGE_PX, crop: 'limit' },
        // Drops EXIF, which on a phone photo can carry GPS coordinates.
        { flags: 'strip_profile' },
      ],
    };

    // Rasterise SVG on the way in. An SVG is an XML document that can carry
    // <script> and event handlers, and object storage serves it verbatim, so
    // keeping one as-is is a stored-XSS vector on the delivery domain.
    // Converting to PNG keeps SVG uploads working with nothing executable left.
    if (input.mimeType === 'image/svg+xml') {
      options.format = 'png';
    }

    const dataUri = `data:${input.mimeType};base64,${input.buffer.toString('base64')}`;

    let result: UploadApiResponse;
    try {
      result = await cloudinary.uploader.upload(dataUri, options);
    } catch (error) {
      this.logger.error(
        `Cloudinary upload failed for ${input.fileName}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException({
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: 'Could not store the uploaded file.',
      });
    }

    return { url: result.secure_url, publicId: result.public_id };
  }

  async delete(publicId: string): Promise<void> {
    if (!this.configured) {
      return;
    }
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (error) {
      // A failed cleanup must not fail the user's request: the asset is
      // orphaned, but the profile row is already consistent.
      this.logger.warn(
        `Cloudinary delete failed for ${publicId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
