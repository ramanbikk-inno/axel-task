import { Injectable } from '@nestjs/common';

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

@Injectable()
export class CloudinaryStorageService implements StorageService {
  async upload(input: StorageUploadInput): Promise<StorageUploadResult> {
    // Cloudinary wiring lands in M2 (photo/logo upload). Stubbed for M0/M1.
    const publicId = `${input.folder ?? 'uploads'}/${input.fileName}`;
    return Promise.resolve({
      url: `https://res.cloudinary.com/stub/${publicId}`,
      publicId,
    });
  }

  async delete(publicId: string): Promise<void> {
    // Stubbed for M0/M1.
    void publicId;
    return Promise.resolve();
  }
}
