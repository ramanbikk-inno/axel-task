import { Logger } from '@nestjs/common';

import { discardAsset } from './discard-asset';
import { StorageService, StorageUploadInput, StorageUploadResult } from './storage.service';

export interface ReplaceStoredAssetOptions<T> {
  storage: StorageService;
  logger: Logger;
  /** The publicId the row points at today, or null when nothing is stored. */
  previousPublicId: string | null;
  /** Null (or omitted) clears the asset instead of replacing it. */
  upload?: StorageUploadInput | null;
  /** Writes the row. Gets the newly stored asset, or null when clearing. */
  persist: (stored: StorageUploadResult | null) => Promise<T>;
}

export interface ReplaceStoredAssetResult<T> {
  /** Whatever `persist` returned — usually the updated row. */
  persisted: T;
  /** The newly stored asset, or null when clearing. */
  stored: StorageUploadResult | null;
}

/**
 * Upload (or clear) an asset, point the row at it, then drop the old one.
 *
 * The order is the point: discarding first would leave the row referencing
 * nothing if the upload or the write then failed, so the previous asset is only
 * released once `persist` has resolved. A throw from either step leaves the old
 * asset intact — a new upload that never got persisted is orphaned instead, which
 * is the side this code has always erred on.
 *
 * `audit.record` stays with the caller: the action and metadata differ per site.
 */
export async function replaceStoredAsset<T>(
  options: ReplaceStoredAssetOptions<T>,
): Promise<ReplaceStoredAssetResult<T>> {
  const { storage, logger, previousPublicId, upload, persist } = options;

  const stored = upload === undefined || upload === null ? null : await storage.upload(upload);
  const persisted = await persist(stored);

  // Re-uploading onto the same publicId replaces the bytes in place; discarding
  // it would delete the asset the row now points at.
  if (previousPublicId !== null && previousPublicId !== stored?.publicId) {
    await discardAsset(storage, previousPublicId, logger);
  }

  return { persisted, stored };
}
