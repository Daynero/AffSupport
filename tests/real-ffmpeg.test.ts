import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { commandExists, probeDuration, probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { customEncoding, optimalEncoding } from './helpers.js';

let temporaryDirectory = '';
afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('real FFmpeg end to end', () => {
  it('runs Optimal mode, preserves the source, FPS and resolution, and produces H.264 MP4', async () => {
    if (!(await toolsAvailable())) return;
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'optimal відео '));
    const input = path.join(temporaryDirectory, 'коротке відео.mov');
    const output = path.join(temporaryDirectory, 'коротке відео_compressed.mp4');
    expect(
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input
      ])
    ).toBe(0);
    const before = createHash('sha256')
      .update(await readFile(input))
      .digest('hex');
    const duration = await probeDuration(input);
    const operation = encodeVideo(input, output, duration, optimalEncoding, false, () => {});
    expect((await operation.done).code).toBe(0);
    const media = await probeMedia(output);
    expect(media).toMatchObject({ width: 320, height: 180, frameRate: 24, codec: 'h264' });
    expect(media.duration).toBeGreaterThan(0);
    expect(
      createHash('sha256')
        .update(await readFile(input))
        .digest('hex')
    ).toBe(before);
  }, 20_000);

  it('runs Custom mode with real FPS and resolution filters without changing the original', async () => {
    if (!(await toolsAvailable())) return;
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'custom video '));
    const input = path.join(temporaryDirectory, 'vertical source.mp4');
    const output = path.join(temporaryDirectory, 'vertical custom.mp4');
    expect(
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=360x640:rate=24',
        '-t',
        '0.8',
        '-c:v',
        'libx264',
        '-an',
        input
      ])
    ).toBe(0);
    const before = createHash('sha256')
      .update(await readFile(input))
      .digest('hex');
    const duration = await probeDuration(input);
    const operation = encodeVideo(
      input,
      output,
      duration,
      { ...customEncoding, frameRate: 12, resolutionLimit: 320, crf: 26 },
      false,
      () => {}
    );
    expect((await operation.done).code).toBe(0);
    const media = await probeMedia(output);
    expect(media.height).toBe(320);
    expect(media.width).toBe(180);
    expect(media.frameRate).toBe(12);
    expect(media.codec).toBe('h264');
    expect(
      createHash('sha256')
        .update(await readFile(input))
        .digest('hex')
    ).toBe(before);
  }, 20_000);
});

async function toolsAvailable() {
  return (await commandExists('ffmpeg')) && (await commandExists('ffprobe'));
}

const run = (command: string, args: string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const process = spawn(command, args, { shell: false });
    process.on('error', reject);
    process.on('close', resolve);
  });
