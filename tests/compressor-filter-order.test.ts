import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFfmpegArgs, buildEstimateArgs } from '../apps/agent/src/ffmpeg/presets.js';
import { ffmpegPath, probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { optimalEncoding } from './helpers.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const exec = promisify(execFile);
let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});
const run = (args: string[]) =>
  exec(ffmpegPath, ['-loglevel', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 });

describeRequiring(ffmpegBinaries, 'compressor filter order equivalence', () => {
  it.each([
    { name: 'landscape', size: '1280x720', rate: '60', hint: 60, target: 30, variable: false },
    { name: 'portrait', size: '720x1280', rate: '120', hint: 120, target: 24, variable: false },
    {
      name: 'fractional',
      size: '640x360',
      rate: '30000/1001',
      hint: 30000 / 1001,
      target: 15,
      variable: false
    },
    { name: 'variable', size: '640x360', rate: '60', hint: 60, target: 24, variable: true }
  ])(
    'keeps video, audio, timing and estimate bytes for $name',
    async sample => {
      directory = await mkdtemp(path.join(os.tmpdir(), 'compressor-filter-'));
      const input = path.join(directory, 'source.mp4');
      await run([
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${sample.size}:rate=${sample.rate}`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '2',
        ...(sample.variable
          ? ['-vf', "select='if(lt(t,1),not(mod(n,3)),not(mod(n,2)))'", '-fps_mode', 'vfr']
          : []),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        input
      ]);
      const settings = { ...optimalEncoding, resolutionLimit: 480, frameRate: sample.target };
      const before = path.join(directory, 'before.mp4');
      const after = path.join(directory, 'after.mp4');
      const firstStarted = performance.now();
      await run(buildFfmpegArgs(input, before, settings, false, null));
      const beforeMs = performance.now() - firstStarted;
      const secondStarted = performance.now();
      await run(buildFfmpegArgs(input, after, settings, false, null, sample.hint));
      const afterMs = performance.now() - secondStarted;
      const original = await probeMedia(before);
      const optimized = await probeMedia(after);
      expect(optimized).toEqual(original);
      for (const stream of ['v:0', 'a:0']) {
        const args = (file: string) => [
          '-i',
          file,
          '-map',
          `0:${stream}`,
          '-f',
          'framemd5',
          'pipe:1'
        ];
        const reference = await run(args(before));
        const result = await run(args(after));
        expect(result.stdout).toBe(reference.stdout);
      }
      expect((await stat(after)).size).toBe((await stat(before)).size);
      const oldSample = path.join(directory, 'before.h264');
      const newSample = path.join(directory, 'after.h264');
      await run(buildEstimateArgs(input, oldSample, 0.25, 1, settings));
      await run(buildEstimateArgs(input, newSample, 0.25, 1, settings, sample.hint));
      expect(await readFile(newSample)).toEqual(await readFile(oldSample));
      console.info('compressor filter timing (single synthetic pair)', {
        name: sample.name,
        beforeMs,
        afterMs
      });
    },
    60_000
  );
});
