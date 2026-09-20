import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const { probeImage, isMediaToolUnavailableError } = vi.hoisted(() => ({
  probeImage: vi.fn(),
  isMediaToolUnavailableError: vi.fn(
    error => error instanceof Error && error.message === 'FFPROBE_UNAVAILABLE'
  )
}));
vi.mock('../apps/agent/src/ffmpeg/tools.js', () => ({ probeImage, isMediaToolUnavailableError }));

import {
  ImageAssetError,
  ImageAssetStore,
  isSupportedImageFile
} from '../apps/agent/src/images/store.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

beforeEach(() => {
  probeImage.mockReset();
  isMediaToolUnavailableError.mockClear();
});

describe('managed image asset storage', () => {
  it('imports and decodes supported images without preserving a user-controlled path', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'image store '));
    probeImage.mockResolvedValue({ width: 64, height: 48, codec: 'mjpeg', frames: 1 });
    const store = new ImageAssetStore(path.join(directory, 'managed'));
    const asset = await store.import(
      Readable.from('jpeg fixture bytes'),
      'Моє фото; $(touch nope).jpeg',
      'image/jpeg'
    );
    expect(asset).toMatchObject({
      fileName: 'Моє фото; $(touch nope).jpeg',
      width: 64,
      height: 48,
      mimeType: 'image/jpeg',
      extension: '.jpg'
    });
    const managedPath = await store.validate(asset);
    expect(path.basename(managedPath)).toBe(`${asset.id}.jpg`);
    expect(managedPath).not.toContain(asset.fileName);
  });

  it('rejects unsupported, damaged and path-injection assets', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'image store errors '));
    const store = new ImageAssetStore(directory);
    await expect(
      store.import(Readable.from('gif'), 'animation.gif', 'image/gif')
    ).rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED_FORMAT' });
    probeImage.mockResolvedValueOnce(null);
    await expect(
      store.import(Readable.from('not png'), 'broken.png', 'image/png')
    ).rejects.toMatchObject({ code: 'IMAGE_DAMAGED' });
    expect(() =>
      store.pathFor({
        id: '../../escape',
        fileName: 'escape.png',
        width: 1,
        height: 1,
        size: 1,
        mimeType: 'image/png',
        extension: '.png'
      })
    ).toThrowError(ImageAssetError);
    expect(isSupportedImageFile('photo.webp', 'image/webp')).toBe(true);
    expect(isSupportedImageFile('photo.jpg', 'image/png')).toBe(false);
  });

  it('reports a blocked media tool instead of blaming the image', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'image store blocked tool '));
    probeImage.mockRejectedValueOnce(new Error('FFPROBE_UNAVAILABLE'));
    const store = new ImageAssetStore(directory);

    await expect(
      store.import(Readable.from('png bytes'), 'opening.png', 'image/png')
    ).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
  });
});
