import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SourceProfile, StitchScreenSegmentPlan } from '@video-compressor/shared';
import {
  buildScreenHoldArgs,
  buildScreenStillArgs,
  buildScreenVideoArgs
} from '../apps/agent/src/ffmpeg/stitch-presets.js';
import { ffmpegPath } from '../apps/agent/src/ffmpeg/tools.js';
import { runTool, toolSucceeded } from '../apps/agent/src/stitcher/run.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';

/*
 * The held screen is fitted once and looped instead of decoded and rescaled for every frame.
 * The promise is that the encoder sees the same frames at the same timestamps, so the decoded
 * pictures and their timing must be identical to the single-step encode, frame for frame.
 */

let directory = '';
let photo = '';

const profile = {
  path: '/unused',
  sizeBytes: 1,
  modifiedAtMs: 0,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 40,
  width: 1280,
  height: 720,
  pixelFormat: 'yuv420p',
  colorRange: 'tv',
  frameRate: 30,
  variableFrameRate: false,
  videoTimescale: 15360,
  durationSeconds: 60,
  hasAudio: false,
  audioCodec: null,
  audioSampleRate: null,
  audioChannels: null,
  audioBitrateKbps: null,
  keyframeTimes: [0]
} as SourceProfile;

const screen = {
  frameRate: 1,
  durationSeconds: 60,
  frames: 60
} as unknown as StitchScreenSegmentPlan;

async function ffmpeg(args: string[]) {
  const result = await runTool(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {});
  if (!toolSucceeded(result)) throw new Error(result.stderr);
  return result;
}

/** Every decoded frame's timestamp and picture hash. */
async function frames(file: string): Promise<string[]> {
  const result = await runTool(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'],
    {}
  );
  if (!toolSucceeded(result)) throw new Error(result.stderr);
  return result.stdout
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split(',').map(part => part.trim()))
    .map(parts => `${parts[2]}|${parts[5]}`);
}

describeRequiring(ffmpegBinaries, 'a held screen fitted once', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'soty-screen-hold-'));
    photo = path.join(directory, 'photo.jpg');
    // A large, detailed JPEG — the kind a Drive pool holds — in full-range YUV.
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=4000x3000:rate=1',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      photo
    ]);
  }, 60_000);
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const fitMode of ['cover', 'contain', 'stretch'] as const) {
    it(`gives the same frames at the same times as the single encode (${fitMode})`, async () => {
      const base = { imagePath: photo, profile, screen, fitMode, threads: null };
      const single = path.join(directory, `${fitMode}-single.mp4`);
      const held = path.join(directory, `${fitMode}-held.mp4`);
      const frame = path.join(directory, `${fitMode}-frame.raw`);

      let started = performance.now();
      await runTool(ffmpegPath, buildScreenVideoArgs({ ...base, output: single }), {});
      const singleMs = performance.now() - started;

      started = performance.now();
      const still = await runTool(
        ffmpegPath,
        buildScreenStillArgs({ ...base, output: held, frameOutput: frame }),
        {}
      );
      expect(toolSucceeded(still)).toBe(true);
      const hold = await runTool(
        ffmpegPath,
        buildScreenHoldArgs({ ...base, output: held, framePath: frame }),
        {}
      );
      expect(toolSucceeded(hold)).toBe(true);
      const heldMs = performance.now() - started;

      const expected = await frames(single);
      expect(expected).toHaveLength(screen.frames);
      expect(await frames(held)).toEqual(expected);
      console.log(`${fitMode}: single ${Math.round(singleMs)} ms, held ${Math.round(heldMs)} ms`);
    }, 120_000);
  }
});
