import { BadRequestException } from '@nestjs/common';

import { ErrorCode } from '../errors/error-codes';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/svg+xml';

export const SUPPORTED_IMAGE_TYPES: ImageMimeType[] = ['image/png', 'image/jpeg', 'image/svg+xml'];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Leading bytes that may legitimately precede `<svg` in a standalone SVG
 * document: a UTF-8 BOM, whitespace, an XML declaration, a DOCTYPE, comments,
 * or processing instructions.
 */
const SVG_PREAMBLE = /^(?:\uFEFF|\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i;

/**
 * Identify an image from its actual bytes.
 *
 * The declared Content-Type on an upload is attacker-controlled, so it can only
 * ever be a hint — a caller claiming `image/png` while sending HTML or a script
 * is precisely the payload worth blocking.
 */
export function detectImageType(buffer: Buffer): ImageMimeType | null {
  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'image/jpeg';
  }

  // SVG is XML, so there is no magic number — check that the first markup the
  // document contains is actually an <svg> element.
  const head = buffer.subarray(0, 1024).toString('utf8');
  const afterPreamble = head.replace(SVG_PREAMBLE, '');
  if (/^<svg[\s>]/i.test(afterPreamble)) {
    return 'image/svg+xml';
  }

  return null;
}

export interface DecodedUpload {
  buffer: Buffer;
  /** The type proven by the bytes, which may differ from what was declared. */
  detectedType: ImageMimeType;
}

/** Ceiling for every user-supplied image: avatars and trainer logos alike. */
export const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Decode a base64 upload and verify it is an image of the declared type,
 * within the size limit.
 */
export function decodeImageUpload(input: {
  dataBase64: string;
  declaredMimeType: string;
  maxBytes: number;
  label: string;
}): DecodedUpload {
  const buffer = Buffer.from(input.dataBase64, 'base64');

  if (buffer.length === 0) {
    throw new BadRequestException({
      errorCode: ErrorCode.VALIDATION_ERROR,
      message: `Empty ${input.label} data.`,
    });
  }
  if (buffer.length > input.maxBytes) {
    throw new BadRequestException({
      errorCode: ErrorCode.FILE_TOO_LARGE,
      message: `${input.label} must be ${Math.floor(input.maxBytes / (1024 * 1024))}MB or smaller.`,
    });
  }

  const detectedType = detectImageType(buffer);
  if (detectedType === null) {
    throw new BadRequestException({
      errorCode: ErrorCode.UNSUPPORTED_FILE_TYPE,
      message: `${input.label} is not a PNG, JPEG or SVG image.`,
    });
  }
  if (detectedType !== input.declaredMimeType) {
    throw new BadRequestException({
      errorCode: ErrorCode.UNSUPPORTED_FILE_TYPE,
      message: `${input.label} content is ${detectedType}, which does not match the declared ${input.declaredMimeType}.`,
    });
  }

  return { buffer, detectedType };
}
