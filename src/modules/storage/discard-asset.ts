import { Logger } from '@nestjs/common';

import { StorageService } from './storage.service';

/** Best-effort cleanup: the row no longer points here, so a failure only leaks a file. */
export async function discardAsset(
  storage: StorageService,
  publicId: string,
  logger: Logger,
): Promise<void> {
  try {
    await storage.delete(publicId);
  } catch (error) {
    logger.warn(
      `Orphaned stored asset ${publicId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
