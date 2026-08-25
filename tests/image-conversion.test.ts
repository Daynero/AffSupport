import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeImage } from '../apps/agent/src/ffmpeg/tools.js';
import {
  ImageConversionError,
  convertImage,
  sourceAlreadyUsesFormat
} from '../apps/agent/src/media-actions/image-converter.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let root = '';

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root);
  root = '';
});

describe('Finder image conversion', () => {
  it('converts to PNG, JPEG and WebP without using a shell', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly image conversion '));
    const source = path.join(root, 'Фото $(touch should-not-exist).png');
    expect(await createStillImage(source)).toBe(0);
    const original = await readFile(source);

    const targets = [
      ['png', path.join(root, 'copy.png'), 'png'],
      ['jpeg', path.join(root, 'copy.jpg'), 'mjpeg'],
      ['webp', path.join(root, 'copy.webp'), 'webp']
    ] as const;
    for (const [format, output, codec] of targets) {
      const result = await convertImage(source, output, format);
      expect(result).toMatchObject({ outputPath: output, width: 40, height: 30 });
      expect(await probeImage(output)).toMatchObject({ width: 40, height: 30, codec });
    }
    expect(await readFile(source)).toEqual(original);
  });

  it('does not overwrite an output that appeared after path planning', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly image collision '));
    const source = path.join(root, 'source.png');
    const output = path.join(root, 'source.jpg');
    expect(await createStillImage(source)).toBe(0);
    await writeFile(output, 'existing');
    await expect(convertImage(source, output, 'jpeg')).rejects.toMatchObject({
      code: 'OUTPUT_EXISTS'
    });
  });

  it('rejects animated images instead of silently dropping frames', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly animated image '));
    const source = path.join(root, 'animation.gif');
    expect(await createAnimatedGif(source)).toBe(0);
    await expect(
      convertImage(source, path.join(root, 'animation.png'), 'png')
    ).rejects.toMatchObject({
      code: 'ANIMATED_IMAGE_UNSUPPORTED'
    } satisfies Partial<ImageConversionError>);
  });

  it('recognizes JPEG aliases as the same target format', () => {
    expect(sourceAlreadyUsesFormat('/tmp/photo.JPG', 'jpeg')).toBe(true);
    expect(sourceAlreadyUsesFormat('/tmp/photo.jpeg', 'jpeg')).toBe(true);
    expect(sourceAlreadyUsesFormat('/tmp/photo.png', 'jpeg')).toBe(false);
  });
});

function createStillImage(file: string) {
  return runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red@0.5:size=40x30,format=rgba',
    '-frames:v',
    '1',
    file
  ]);
}

function createAnimatedGif(file: string) {
  return runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=24x16:rate=2', '-t', '1', file]);
}

function runFfmpeg(args: string[]) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      shell: false
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
}
