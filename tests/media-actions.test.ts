import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMAGE_CONVERSION_FORMATS,
  ImageConversionError,
  type ImageConversionFormat
} from '../apps/agent/src/media-actions/image-converter.js';
import { MediaActionQueue } from '../apps/agent/src/media-actions/queue.js';

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('native media action queue', () => {
  it('exposes only the requested image targets', () => {
    expect(IMAGE_CONVERSION_FORMATS).toEqual(['png', 'jpeg', 'webp']);
  });

  it('serializes work and reserves distinct sibling paths', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media queue '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let active = 0;
    let maximumActive = 0;
    const outputs: string[] = [];
    const queue = new MediaActionQueue(
      () => {},
      async (inputPath, outputPath) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        outputs.push(outputPath);
        await writeFile(outputPath, `converted from ${inputPath}`, { flag: 'wx' });
        active -= 1;
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );

    const accepted = await queue.addImageConversions([source, source], 'jpeg');
    await queue.shutdown();

    expect(maximumActive).toBe(1);
    expect(outputs.map(value => path.basename(value))).toEqual(['photo.jpg', 'photo_2.jpg']);
    expect(accepted.map(job => path.basename(job.outputPath ?? ''))).toEqual([
      'photo.jpg',
      'photo_2.jpg'
    ]);
    expect(queue.state().jobs.every(job => job.status === 'completed')).toBe(true);
  });

  it('skips a matching source and preserves structured converter failures', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media failures '));
    const png = path.join(root, 'already.PNG');
    const source = path.join(root, 'source.png');
    await Promise.all([writeFile(png, 'source'), writeFile(source, 'source')]);
    const attempted: ImageConversionFormat[] = [];
    const queue = new MediaActionQueue(
      () => {},
      async (_inputPath, _outputPath, format) => {
        attempted.push(format);
        throw new ImageConversionError('ENCODE_FAILED', 'The encoder rejected this image.');
      }
    );

    await queue.addImageConversions([png], 'png');
    await queue.addImageConversions([source], 'webp');
    await queue.shutdown();

    expect(attempted).toEqual(['webp']);
    expect(queue.state().jobs).toMatchObject([
      {
        status: 'skipped',
        errorCode: 'ALREADY_TARGET_FORMAT'
      },
      {
        status: 'failed',
        errorCode: 'ENCODE_FAILED',
        error: 'The encoder rejected this image.'
      }
    ]);
  });

  it('replans when a target appears after the request was accepted', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly late collision '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let attempts = 0;
    const queue = new MediaActionQueue(
      () => {},
      async (_inputPath, outputPath) => {
        attempts += 1;
        if (attempts === 1) {
          await writeFile(outputPath, 'created by another process', { flag: 'wx' });
          throw new ImageConversionError('OUTPUT_EXISTS', 'The target appeared.');
        }
        await writeFile(outputPath, 'converted', { flag: 'wx' });
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );

    await queue.addImageConversions([source], 'jpeg');
    await queue.shutdown();

    expect(attempts).toBe(2);
    expect(queue.state().jobs[0]).toMatchObject({
      outputPath: path.join(root, 'photo_2.jpg'),
      status: 'completed'
    });
  });
});
