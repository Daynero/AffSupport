import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { optimalEncoding } from './helpers.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';

/**
 * End-to-end runs against real media, where "real" is the point: the parts of
 * the pipeline that only misbehave with an actual decoder attached.
 *
 * **Equivalence here is decoded content, never bytes.** Multi-threaded x264 is
 * not deterministic — the thread count alone changes slice boundaries — and the
 * limiter suspends and resumes processes mid-encode. A byte comparison would
 * therefore fail on a correct implementation, and the natural way to make it
 * pass would be to stop varying the thread count, which is the throttle itself.
 */

let temporaryDirectory = '';

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('close', code => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
}

async function sourceClip(directory: string) {
  const input = path.join(directory, 'source.mov');
  const code = await run('ffmpeg', [
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
    '2',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    input
  ]);
  expect(code).toBe(0);
  return input;
}

async function encodeWith(governor: PowerGovernor | null, input: string, output: string) {
  const { done } = encodeVideo(
    input,
    output,
    null,
    optimalEncoding,
    true,
    () => {},
    undefined,
    governor
  );
  return done;
}

describeRequiring(ffmpegBinaries, 'real media end to end', () => {
  it('produces equivalent output throttled and unthrottled', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'wishly-real-media-'));
    const input = await sourceClip(temporaryDirectory);

    const throttled = new PowerGovernor({ cpuCount: os.cpus().length });
    await throttled.setLimit(30);
    const limitedOut = path.join(temporaryDirectory, 'limited.mp4');
    const freeOut = path.join(temporaryDirectory, 'free.mp4');

    await encodeWith(throttled, input, limitedOut);
    await throttled.shutdown();
    await encodeWith(null, input, freeOut);

    const limited = await probeMedia(limitedOut);
    const free = await probeMedia(freeOut);

    // Guard the comparison itself: a probe that returned nothing would make
    // every assertion below trivially true.
    expect(limited.width).not.toBeNull();
    expect(limited.duration).not.toBeNull();

    // What a user would notice: the same picture, for the same length of time.
    expect(limited.width).toBe(free.width);
    expect(limited.height).toBe(free.height);
    expect(limited.codec).toBe(free.codec);
    expect(limited.hasAudio).toBe(free.hasAudio);
    expect(limited.audioCodec).toBe(free.audioCodec);
    // Duration is compared with a tolerance of one frame at the output rate:
    // a container's duration is written from timestamps, and the last frame's
    // is not bit-identical across runs.
    expect(Math.abs((limited.duration ?? 0) - (free.duration ?? 0))).toBeLessThanOrEqual(0.1);
  }, 180_000);
});
