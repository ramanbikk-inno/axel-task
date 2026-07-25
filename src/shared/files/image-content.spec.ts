import { BadRequestException } from '@nestjs/common';

import { ErrorCode } from '../errors/error-codes';
import { decodeImageUpload, detectImageType } from './image-content';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const SVG_WITH_PREAMBLE = Buffer.from(
  '﻿<?xml version="1.0"?>\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const body = (error as BadRequestException).getResponse() as { errorCode: string };
    return body.errorCode;
  }
  throw new Error('expected a throw');
}

describe('detectImageType', () => {
  it('recognises a PNG by its magic bytes', () => {
    expect(detectImageType(PNG)).toBe('image/png');
  });

  it('recognises a JPEG by its magic bytes', () => {
    expect(detectImageType(JPEG)).toBe('image/jpeg');
  });

  it('recognises an SVG document', () => {
    expect(detectImageType(SVG)).toBe('image/svg+xml');
  });

  it('recognises an SVG behind a BOM, XML declaration and comment', () => {
    expect(detectImageType(SVG_WITH_PREAMBLE)).toBe('image/svg+xml');
  });

  it.each([
    ['HTML', '<html><script>alert(1)</script></html>'],
    ['a bare script', '<script>alert(1)</script>'],
    ['a shell script', '#!/bin/sh\nrm -rf /'],
    ['plain text', 'not an image at all'],
  ])('does not accept %s as an image', (_label: string, content: string) => {
    expect(detectImageType(Buffer.from(content))).toBeNull();
  });

  it('does not accept an SVG that only appears later in the document', () => {
    // Otherwise an HTML page with an inline <svg> would pass as an image.
    expect(detectImageType(Buffer.from('<html><body><svg></svg></body></html>'))).toBeNull();
  });
});

describe('decodeImageUpload', () => {
  const opts = { maxBytes: 2 * 1024 * 1024, label: 'Logo' };

  it('accepts a PNG declared as image/png', () => {
    const result = decodeImageUpload({
      dataBase64: PNG.toString('base64'),
      declaredMimeType: 'image/png',
      ...opts,
    });

    expect(result.detectedType).toBe('image/png');
    expect(result.buffer.equals(PNG)).toBe(true);
  });

  it('rejects a script uploaded under a declared image/png', () => {
    expect(
      codeOf(() =>
        decodeImageUpload({
          dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
          declaredMimeType: 'image/png',
          ...opts,
        }),
      ),
    ).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
  });

  it('rejects a real image whose declared type is a lie', () => {
    expect(
      codeOf(() =>
        decodeImageUpload({
          dataBase64: JPEG.toString('base64'),
          declaredMimeType: 'image/png',
          ...opts,
        }),
      ),
    ).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
  });

  it('rejects an oversized image', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);

    expect(
      codeOf(() =>
        decodeImageUpload({
          dataBase64: big.toString('base64'),
          declaredMimeType: 'image/png',
          ...opts,
        }),
      ),
    ).toBe(ErrorCode.FILE_TOO_LARGE);
  });

  it('rejects empty data', () => {
    expect(
      codeOf(() => decodeImageUpload({ dataBase64: '', declaredMimeType: 'image/png', ...opts })),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('accepts an SVG declared as image/svg+xml (rasterised later, at storage)', () => {
    const result = decodeImageUpload({
      dataBase64: SVG.toString('base64'),
      declaredMimeType: 'image/svg+xml',
      ...opts,
    });

    expect(result.detectedType).toBe('image/svg+xml');
  });
});
