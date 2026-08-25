import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ImageAsset,
  JobImageEmbedding,
  StartImageDurationMode
} from '../packages/shared/src/types.js';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { optimalEncoding, makeEmbedding } from './helpers.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
let startImagePath = '';

describeRequiring(ffmpegBinaries, 'real image embedding filter graph', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedded ffmpeg '));
    startImagePath = path.join(directory, 'початок & кадр.png');
    expect(
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=120x120',
        '-frames:v',
        '1',
        '-threads',
        '1',
        startImagePath
      ])
    ).toBe(0);
  });

  afterAll(async () => {
    if (directory) await removeTemporaryDirectory(directory);
  });

  for (const fps of [24, 30, 60]) {
    it(`adds exactly one opening frame at ${fps} FPS with matching silence`, async () => {
      const input = path.join(directory, `source ${fps}.mp4`);
      const output = path.join(directory, `result ${fps}.mp4`);
      expect(await createVideo(input, fps, true)).toBe(0);
      const source = await probeMedia(input);
      const embedding: JobImageEmbedding = makeEmbedding({
        startImage: imageAsset('11111111-1111-4111-8111-111111111111'),
        endImage: null,
        finalDurationMode: 'random-40-50',
        finalDurationSeconds: null,
        fitMode: 'cover'
      });
      const totalDuration = source.duration! + 1 / fps;
      const operation = encodeVideo(
        input,
        output,
        totalDuration,
        optimalEncoding,
        false,
        () => {},
        {
          // Whole source, so no leading trim.
          sourceStartSeconds: 0,
          sourceDurationSeconds: source.duration!,
          sourceHasAudio: true,
          width: 160,
          height: 90,
          frameRate: fps,
          imageEmbedding: embedding,
          startImagePath,
          endImagePath: null
        }
      );
      const result = await operation.done;
      expect(result.code, result.stderr).toBe(0);
      const media = await probeMedia(output);
      expect(media).toMatchObject({ width: 160, height: 90, frameRate: fps, hasAudio: true });
      expect(media.duration).toBeCloseTo(totalDuration, 1);
      expect(Math.abs((media.audioDuration ?? 0) - (media.videoDuration ?? 0))).toBeLessThan(0.12);
      const hashes = await firstFrameHashes(output, 3);
      expect(hashes).toHaveLength(3);
      expect(hashes[0]).not.toBe(hashes[1]);
      expect(hashes[1]).toBe(hashes[2]);
      const silenceEnd = await firstSilenceEnd(output);
      expect(Math.abs(silenceEnd - 1 / fps)).toBeLessThan(0.025);
    }, 20_000);
  }

  it('uses the original fractional FPS in optimal mode for the one-frame opening', async () => {
    const input = path.join(directory, 'source 29.97.mp4');
    const output = path.join(directory, 'result 29.97.mp4');
    expect(await createVideo(input, '30000/1001', true)).toBe(0);
    const source = await probeMedia(input);
    expect(source.frameRate).toBeCloseTo(29.97, 2);
    const operation = encodeVideo(
      input,
      output,
      source.duration! + 1 / source.frameRate!,
      optimalEncoding,
      false,
      () => {},
      {
        // Whole source, so no leading trim.
        sourceStartSeconds: 0,
        sourceDurationSeconds: source.duration!,
        sourceHasAudio: true,
        width: 160,
        height: 90,
        frameRate: source.frameRate!,
        imageEmbedding: makeEmbedding({
          startImage: imageAsset('55555555-5555-4555-8555-555555555555'),
          endImage: null,
          finalDurationMode: 'random-40-50',
          finalDurationSeconds: null,
          fitMode: 'cover'
        }),
        startImagePath,
        endImagePath: null
      }
    );
    const result = await operation.done;
    expect(result.code, result.stderr).toBe(0);
    expect((await probeMedia(output)).frameRate).toBeCloseTo(29.97, 2);
    const hashes = await firstFrameHashes(output, 3);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);
  }, 20_000);

  // A start duration below one frame period must not hang FFmpeg (trimming the looped image by a
  // sub-frame duration stalls the encode); the requested offset still lands in the total duration.
  for (const [mode, ms] of [
    ['ms-2', 2],
    ['ms-10', 10]
  ] as [StartImageDurationMode, number][]) {
    it(`embeds a sub-frame ${ms}ms opening at 30 FPS without hanging`, async () => {
      const input = path.join(directory, `sub ${mode}.mp4`);
      const output = path.join(directory, `sub ${mode} out.mp4`);
      expect(await createVideo(input, 30, true)).toBe(0);
      const source = await probeMedia(input);
      const operation = encodeVideo(
        input,
        output,
        source.duration! + ms / 1000,
        optimalEncoding,
        false,
        () => {},
        {
          // Whole source, so no leading trim.
          sourceStartSeconds: 0,
          sourceDurationSeconds: source.duration!,
          sourceHasAudio: true,
          width: 160,
          height: 90,
          frameRate: 30,
          imageEmbedding: makeEmbedding({
            startImage: imageAsset('22222222-2222-4222-8222-222222222222'),
            endImage: null,
            startDurationMode: mode,
            customStartDurationMs: ms,
            finalDurationMode: 'random-40-50',
            finalDurationSeconds: null,
            fitMode: 'cover',
            replaceExisting: false,
            sourceTrimStartSeconds: 0,
            sourceTrimEndSeconds: 0
          }),
          startImagePath,
          endImagePath: null
        }
      );
      const result = await operation.done;
      expect(result.code, result.stderr).toBe(0);
      const media = await probeMedia(output);
      expect(media).toMatchObject({ width: 160, height: 90, hasAudio: true });
      expect(media.duration).toBeCloseTo(source.duration! + ms / 1000, 2);
    }, 20_000);
  }

  it('creates full-length stereo silence for a source without audio and a final image', async () => {
    const input = path.join(directory, 'silent source.mp4');
    const output = path.join(directory, 'silent source embedded.mp4');
    expect(await createVideo(input, 30, false)).toBe(0);
    const source = await probeMedia(input);
    const embedding: JobImageEmbedding = makeEmbedding({
      startImage: null,
      endImage: imageAsset('22222222-2222-4222-8222-222222222222'),
      finalDurationMode: 'custom',
      finalDurationSeconds: 0.4,
      fitMode: 'contain'
    });
    const operation = encodeVideo(
      input,
      output,
      source.duration! + 0.4,
      optimalEncoding,
      false,
      () => {},
      {
        // Whole source, so no leading trim.
        sourceStartSeconds: 0,
        sourceDurationSeconds: source.duration!,
        sourceHasAudio: false,
        width: 160,
        height: 90,
        frameRate: 30,
        imageEmbedding: embedding,
        startImagePath: null,
        endImagePath: startImagePath
      }
    );
    const result = await operation.done;
    expect(result.code, result.stderr).toBe(0);
    const media = await probeMedia(output);
    expect(media.hasAudio).toBe(true);
    expect(media.audioChannels).toBe(2);
    expect(media.duration).toBeCloseTo(source.duration! + 0.4, 1);
  }, 20_000);

  it('encodes the stretch adaptation mode at the exact output size', async () => {
    const input = path.join(directory, 'stretch source.mp4');
    const output = path.join(directory, 'stretch result.mp4');
    expect(await createVideo(input, 24, true)).toBe(0);
    const source = await probeMedia(input);
    const operation = encodeVideo(
      input,
      output,
      source.duration! + 0.2,
      optimalEncoding,
      false,
      () => {},
      {
        // Whole source, so no leading trim.
        sourceStartSeconds: 0,
        sourceDurationSeconds: source.duration!,
        sourceHasAudio: true,
        width: 128,
        height: 128,
        frameRate: 24,
        imageEmbedding: makeEmbedding({
          startImage: null,
          endImage: imageAsset('33333333-3333-4333-8333-333333333333'),
          finalDurationMode: 'custom',
          finalDurationSeconds: 0.2,
          fitMode: 'stretch'
        }),
        startImagePath: null,
        endImagePath: startImagePath
      }
    );
    const result = await operation.done;
    expect(result.code, result.stderr).toBe(0);
    expect(await probeMedia(output)).toMatchObject({ width: 128, height: 128, frameRate: 24 });
  }, 20_000);
});

function imageAsset(id: string): ImageAsset {
  return {
    id,
    fileName: 'початок & кадр.png',
    width: 120,
    height: 120,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

function createVideo(file: string, fps: number | string, audio: boolean) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:size=160x90:rate=${fps}`
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ac', '1', '-shortest');
  else args.push('-an');
  args.push(file);
  return run('ffmpeg', args);
}

async function firstSilenceEnd(file: string) {
  const result = await capture('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'silencedetect=n=-50dB:d=0.002',
    '-f',
    'null',
    '-'
  ]);
  expect(result.code, result.stderr).toBe(0);
  const match = /silence_end:\s*([0-9.]+)/.exec(result.stderr);
  expect(match, result.stderr).not.toBeNull();
  return Number(match![1]);
}

async function firstFrameHashes(file: string, count: number) {
  const result = await capture('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-frames:v',
    String(count),
    '-f',
    'framemd5',
    'pipe:1'
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split(',').at(-1)?.trim());
}

const run = (command: string, args: string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    child.on('error', reject);
    child.on('close', resolve);
  });

const capture = (command: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
      stdout += data;
    });
    child.stderr.on('data', data => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
