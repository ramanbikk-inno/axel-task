/**
 * Real image bytes for upload tests.
 *
 * Uploads are content-sniffed (see shared/files/image-content.ts), so a
 * placeholder like Buffer.from('fake-logo') declared as image/png is now
 * correctly rejected — that is exactly the disguised-payload case the sniffing
 * exists to catch. Test fixtures have to be genuine images.
 */

/** A valid 1x1 transparent PNG. */
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

/** A minimal, well-formed SVG document. */
export const SVG_DOC = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
);

export const SVG_DOC_BASE64 = SVG_DOC.toString('base64');

/**
 * Oversized but genuine PNG: real magic bytes followed by padding, so it trips
 * the size limit rather than the content check.
 */
export function oversizedPngBase64(maxBytes: number): string {
  return Buffer.concat([PNG_1X1, Buffer.alloc(maxBytes)]).toString('base64');
}
