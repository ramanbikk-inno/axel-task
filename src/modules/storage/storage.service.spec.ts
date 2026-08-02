import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

import { replaceStoredAsset } from './replace-asset';
import {
  CloudinaryStorageService,
  MAX_EDGE_PX,
  StorageService,
  StorageUploadResult,
} from './storage.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload: jest.fn(), destroy: jest.fn() },
  },
}));

const uploadMock = cloudinary.uploader.upload as unknown as jest.Mock;
const destroyMock = cloudinary.uploader.destroy as unknown as jest.Mock;

function service(cloudinaryUrl: string): CloudinaryStorageService {
  // Deliberately a stub, not a real ConfigService: ConfigService.get() prefers
  // process.env over the values it was constructed with, and CI exports
  // CLOUDINARY_URL — so the "unconfigured" case silently became configured and
  // this suite passed locally while failing in CI.
  return new CloudinaryStorageService({
    get: <T>(): T => cloudinaryUrl as unknown as T,
  } as unknown as ConfigService);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('CloudinaryStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uploadMock.mockResolvedValue({
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/logos/abc.png',
      public_id: 'logos/abc',
    });
  });

  it('fails loudly when storage is not configured, instead of inventing a URL', async () => {
    const unconfigured = service('');

    // The old stub returned https://res.cloudinary.com/stub/<name> here, so
    // uploads "succeeded" while nothing was stored and a dead URL was
    // persisted onto the user or trainer row.
    await expect(
      unconfigured.upload({ buffer: PNG, fileName: 'a.png', mimeType: 'image/png' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploads and returns the real delivery URL and public id', async () => {
    const result = await service('cloudinary://k:s@demo').upload({
      buffer: PNG,
      fileName: 'logo.png',
      mimeType: 'image/png',
      folder: 'logos',
    });

    expect(result).toEqual({
      url: 'https://res.cloudinary.com/demo/image/upload/v1/logos/abc.png',
      publicId: 'logos/abc',
    });
    const [dataUri, options] = uploadMock.mock.calls[0];
    expect(dataUri).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(options.folder).toBe('logos');
    expect(options.resource_type).toBe('image');
  });

  it('caps the stored image to the maximum edge and strips metadata', async () => {
    await service('cloudinary://k:s@demo').upload({
      buffer: PNG,
      fileName: 'huge.png',
      mimeType: 'image/png',
    });

    const [, options] = uploadMock.mock.calls[0];
    // `limit` only ever scales down, so a small image is stored untouched
    // (asks for auto-resize, not rejection).
    expect(options.transformation).toEqual([
      { width: MAX_EDGE_PX, height: MAX_EDGE_PX, crop: 'limit' },
      { flags: 'strip_profile' },
    ]);
  });

  it('rasterises an SVG to PNG so nothing executable is ever stored', async () => {
    await service('cloudinary://k:s@demo').upload({
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      fileName: 'logo.svg',
      mimeType: 'image/svg+xml',
    });

    const [, options] = uploadMock.mock.calls[0];
    expect(options.format).toBe('png');
  });

  it('does not force a format for raster uploads', async () => {
    await service('cloudinary://k:s@demo').upload({
      buffer: PNG,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
    });

    const [, options] = uploadMock.mock.calls[0];
    expect(options.format).toBeUndefined();
  });

  it('translates a provider failure into a 500 rather than leaking the cause', async () => {
    uploadMock.mockRejectedValue(new Error('cloudinary said no: api_key=secret'));

    await expect(
      service('cloudinary://k:s@demo').upload({
        buffer: PNG,
        fileName: 'a.png',
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({
      status: 500,
      response: { message: 'Could not store the uploaded file.' },
    });
  });

  it('swallows a failed delete so cleanup cannot fail the user’s request', async () => {
    destroyMock.mockRejectedValue(new Error('gone'));

    await expect(service('cloudinary://k:s@demo').delete('logos/abc')).resolves.toBeUndefined();
  });
});

const NEW_ASSET: StorageUploadResult = { url: 'https://cdn/new.png', publicId: 'avatars/new' };
const UPLOAD = { buffer: PNG, fileName: 'new.png', mimeType: 'image/png', folder: 'avatars' };

describe('replaceStoredAsset', () => {
  let calls: string[];
  let storage: StorageService;
  let logger: Logger;

  beforeEach(() => {
    calls = [];
    storage = {
      upload: jest.fn(async () => {
        calls.push('upload');
        return NEW_ASSET;
      }),
      delete: jest.fn(async () => {
        calls.push('delete');
      }),
    };
    logger = { warn: jest.fn() } as unknown as Logger;
  });

  const persistSpy = (): jest.Mock =>
    jest.fn(async () => {
      calls.push('persist');
      return 'row';
    });

  it('uploads, persists, then discards the previous asset — in that order', async () => {
    const persist = persistSpy();

    const result = await replaceStoredAsset({
      storage,
      logger,
      previousPublicId: 'avatars/old',
      upload: UPLOAD,
      persist,
    });

    expect(calls).toEqual(['upload', 'persist', 'delete']);
    expect(persist).toHaveBeenCalledWith(NEW_ASSET);
    expect(storage.delete).toHaveBeenCalledWith('avatars/old');
    expect(result).toEqual({ persisted: 'row', stored: NEW_ASSET });
  });

  it('has nothing to discard on a first upload', async () => {
    await replaceStoredAsset({
      storage,
      logger,
      previousPublicId: null,
      upload: UPLOAD,
      persist: persistSpy(),
    });

    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('keeps the asset when the upload reused the same publicId', async () => {
    await replaceStoredAsset({
      storage,
      logger,
      previousPublicId: NEW_ASSET.publicId,
      upload: UPLOAD,
      persist: persistSpy(),
    });

    // The bytes were replaced in place; deleting would remove what the row now
    // points at.
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('clears the row without uploading, then discards the previous asset', async () => {
    const persist = persistSpy();

    const result = await replaceStoredAsset({
      storage,
      logger,
      previousPublicId: 'avatars/old',
      persist,
    });

    expect(storage.upload).not.toHaveBeenCalled();
    expect(calls).toEqual(['persist', 'delete']);
    expect(persist).toHaveBeenCalledWith(null);
    expect(storage.delete).toHaveBeenCalledWith('avatars/old');
    expect(result.stored).toBeNull();
  });

  it('leaves the previous asset in place when persisting fails', async () => {
    // Orphaning the new upload is the accepted cost; deleting the old one would
    // leave the row pointing at nothing.
    await expect(
      replaceStoredAsset({
        storage,
        logger,
        previousPublicId: 'avatars/old',
        upload: UPLOAD,
        persist: async () => {
          throw new Error('db down');
        },
      }),
    ).rejects.toThrow('db down');

    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('never persists or discards when the upload fails', async () => {
    (storage.upload as jest.Mock).mockRejectedValue(new Error('provider down'));
    const persist = persistSpy();

    await expect(
      replaceStoredAsset({
        storage,
        logger,
        previousPublicId: 'avatars/old',
        upload: UPLOAD,
        persist,
      }),
    ).rejects.toThrow('provider down');

    expect(persist).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('does not fail the request when the discard fails', async () => {
    (storage.delete as jest.Mock).mockRejectedValue(new Error('gone'));

    await expect(
      replaceStoredAsset({
        storage,
        logger,
        previousPublicId: 'avatars/old',
        upload: UPLOAD,
        persist: persistSpy(),
      }),
    ).resolves.toMatchObject({ persisted: 'row' });
    expect(logger.warn).toHaveBeenCalled();
  });
});
