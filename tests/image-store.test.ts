import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {
  ImageAssetError,
  ImageAssetStore,
  isSupportedImageFile
} from '../apps/agent/src/images/store.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('managed image asset storage', () => {
  it('imports and decodes supported images without preserving a user-controlled path', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'image store '));
    const source = path.join(directory, 'джерело.jpg');
    expect(await createImage(source)).toBe(0);
    const store = new ImageAssetStore(path.join(directory, 'managed'));
    const asset = await store.import(
      Readable.from(await readFile(source)),
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
});

function createImage(file: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=64x48',
        '-frames:v',
        '1',
        file
      ],
      { shell: false }
    );
    child.on('error', reject);
    child.on('close', resolve);
  });
}
