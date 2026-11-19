import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HELD_PICTURE_DIRECT_FRAMES,
  HELD_PICTURE_GOP_FRAMES,
  HELD_PICTURE_SEED_FRAMES,
  buildHeldCutArgs,
  buildHeldPicture,
  buildHeldRepeatArgs,
  buildPacketHashProbeArgs,
  heldPictureEncoderArgs,
  heldSeedShape,
  type HeldStep
} from '../apps/agent/src/ffmpeg/held-picture.js';
import { buildHeldScreenPictureArgs } from '../apps/agent/src/ffmpeg/presets.js';
import { ffmpegPath, ffprobePath } from '../apps/agent/src/ffmpeg/tools.js';
import { runTool, toolSucceeded } from '../apps/agent/src/stitcher/run.js';
import { describeRequiring } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { ffmpegBinaries } from './support/toolchain.js';

/*
 * A held screen runs at the body's frame rate, because Facebook re-encodes an upload at the
 * file's *average* rate and a sparse screen dragged that to five frames a second. The frames
 * are assembled from a short seed rather than encoded, and that is only sound while the
 * seed's repeats really are periodic — so the period is measured, and these tests hold the
 * measuring to its word.
 */

/** ffprobe's `size,flags,hash` table for a picture followed by repeats with a period. */
function seedTable(period: number, total = HELD_PICTURE_SEED_FRAMES, endNoise = 8): string {
  const lines = ['52000,K__,MD5:picture'];
  for (let index = 1; index < total; index += 1) {
    const noisy = index >= total - endNoise;
    lines.push(`43,___,MD5:${noisy ? `end${index}` : `repeat${(index - 1) % period}`}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('the shape a seed must have', () => {
  it.each([16, 32, 64])('measures a period of %i', period => {
    const shape = heldSeedShape(seedTable(period));
    expect(shape).toMatchObject({ period, pictureBytes: 52000, repeatBytes: 43 });
    expect(shape?.cycle).toHaveLength(period);
    // The cycle is the period that follows the head, so it begins where the period begins.
    expect(shape?.cycle[0]).toBe('MD5:repeat0');
  });

  it('never compares the encoder’s uneven last frames', () => {
    // x264 writes the last few frames of any run differently; they are not part of the period.
    expect(heldSeedShape(seedTable(32, HELD_PICTURE_SEED_FRAMES, 8))?.period).toBe(32);
  });

  it('refuses a seed that does not repeat', () => {
    const lines = ['52000,K__,MD5:picture'];
    for (let index = 1; index < HELD_PICTURE_SEED_FRAMES; index += 1)
      lines.push(`43,___,MD5:unique${index}`);
    expect(heldSeedShape(lines.join('\n'))).toBeNull();
  });

  it('refuses a seed with a second keyframe or no first one', () => {
    const table = seedTable(32).split('\n');
    table[40] = '52000,K__,MD5:picture';
    expect(heldSeedShape(table.join('\n'))).toBeNull();
    expect(heldSeedShape(seedTable(32).replace('K__', '___'))).toBeNull();
    expect(heldSeedShape('')).toBeNull();
  });

  it('refuses a seed too short to show three periods', () => {
    expect(heldSeedShape(seedTable(64, 150))).toBeNull();
  });
});

describe('the arguments of the assembly', () => {
  it('forces every picture after the first to an empty repeat', () => {
    expect(heldPictureEncoderArgs(209)).toEqual(['-x264-params', 'zones=1,208,q=51']);
    // Two frames are still a picture and one repeat.
    expect(heldPictureEncoderArgs(2)).toEqual(['-x264-params', 'zones=1,1,q=51']);
  });

  it('cuts the head and the cycle from the seed in one run', () => {
    const args = buildHeldCutArgs({
      seedPath: '/w/seed.mp4',
      headPath: '/w/head.mp4',
      cyclePath: '/w/cycle.mp4',
      period: 32,
      frameRate: 30,
      timescale: 15360
    });
    const head = args.slice(0, args.indexOf('/w/head.mp4') + 1);
    const cycle = args.slice(args.indexOf('/w/head.mp4') + 1);
    // The picture and one whole period, so whatever follows starts where the period starts.
    expect(head[head.indexOf('-frames:v') + 1]).toBe('33');
    // The next period alone: a file with no keyframe, which a copy must be told to keep.
    expect(cycle[cycle.indexOf('-frames:v') + 1]).toBe('32');
    expect(cycle).toContain('-copyinkf');
    // Half a frame before frame 33, never on a rounding edge.
    expect(Number(cycle[cycle.indexOf('-ss') + 1])).toBeCloseTo(32.5 / 30, 6);
  });

  it('restamps only the last assembly, by counting frames', () => {
    const middle = buildHeldRepeatArgs({
      listPath: '/w/block.txt',
      output: '/w/block.mp4',
      frames: 1024,
      timescale: 15360
    });
    expect(middle).not.toContain('-bsf:v');
    expect(middle).toContain('-copyinkf');
    const last = buildHeldRepeatArgs({
      listPath: '/w/screen.txt',
      output: '/w/screen.mp4',
      frames: 72000,
      timescale: 15360,
      retimeFrameRate: 30
    });
    expect(last[last.indexOf('-bsf:v') + 1]).toBe(
      'setts=ts=round(N*512):duration=round((N+1)*512)-round(N*512)'
    );
    expect(last[last.indexOf('-frames:v') + 1]).toBe('72000');
  });

  it('asks ffprobe for the hash of every packet', () => {
    const args = buildPacketHashProbeArgs('/w/seed.mp4');
    expect(args).toContain('-show_data_hash');
    expect(args.join(' ')).toContain('packet=size,flags,data_hash');
  });
});

describe('the roads a held picture can take', () => {
  const runner = (hashes: string | null, calls: string[][], step: HeldStep = 'ok') => ({
    ffmpeg: async (args: string[]) => {
      calls.push(args);
      return step;
    },
    ffprobe: async () => hashes
  });

  it('simply encodes a short screen', async () => {
    const encoded: number[] = [];
    const calls: string[][] = [];
    const result = await buildHeldPicture({
      frames: HELD_PICTURE_DIRECT_FRAMES,
      frameRate: 30,
      timescale: 15360,
      workDir: os.tmpdir(),
      name: 'outro',
      output: '/w/out.mp4',
      encode: async frames => {
        encoded.push(frames);
        return 'ok';
      },
      runner: runner(null, calls)
    });
    expect(result).toEqual({ step: 'ok', road: 'direct' });
    expect(encoded).toEqual([HELD_PICTURE_DIRECT_FRAMES]);
    expect(calls).toHaveLength(0);
  });

  it('encodes the whole length when the seed does not repeat', async () => {
    const encoded: number[] = [];
    const result = await buildHeldPicture({
      frames: 72_000,
      frameRate: 30,
      timescale: 15360,
      workDir: os.tmpdir(),
      name: 'outro',
      output: '/w/out.mp4',
      encode: async frames => {
        encoded.push(frames);
        return 'ok';
      },
      runner: runner('1,K__,MD5:a\n2,___,MD5:b\n', [])
    });
    // Slower, and always correct: the short road may only ever save time.
    expect(result).toEqual({ step: 'ok', road: 'fallback' });
    expect(encoded).toEqual([HELD_PICTURE_SEED_FRAMES, 72_000]);
  });

  it('stops at a cancellation instead of taking the long road', async () => {
    const encoded: number[] = [];
    const result = await buildHeldPicture({
      frames: 72_000,
      frameRate: 30,
      timescale: 15360,
      workDir: os.tmpdir(),
      name: 'outro',
      output: '/w/out.mp4',
      encode: async frames => {
        encoded.push(frames);
        return 'cancelled';
      },
      runner: runner(null, [])
    });
    expect(result.step).toBe('cancelled');
    expect(encoded).toEqual([HELD_PICTURE_SEED_FRAMES]);
  });
});

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function tool(command: string, args: string[]) {
  const result = await runTool(command, args, {});
  if (!toolSucceeded(result)) throw new Error(result.stderr);
  return result.stdout;
}

describeRequiring(ffmpegBinaries, 'a held picture assembled by the real encoder', () => {
  it.each([
    ['30 fps', 30, 15360, HELD_PICTURE_GOP_FRAMES * 2 + 500],
    ['29.97 fps', 30000 / 1001, 30000, HELD_PICTURE_GOP_FRAMES + 77],
    ['one group of pictures', 60, 15360, 4000]
  ] as const)(
    'is one picture on an exact frame grid (%s)',
    async (_label, frameRate, timescale, frames) => {
      directory = await mkdtemp(path.join(os.tmpdir(), 'held-picture-'));
      const photo = path.join(directory, 'photo.png');
      await tool(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=1',
        '-frames:v',
        '1',
        photo
      ]);
      const output = path.join(directory, 'screen.mp4');
      let spawned = 0;
      const step = async (args: string[]): Promise<HeldStep> => {
        spawned += 1;
        const result = await runTool(ffmpegPath, args, {});
        return toolSucceeded(result) ? 'ok' : 'failed';
      };
      const started = performance.now();
      const result = await buildHeldPicture({
        frames,
        frameRate,
        timescale,
        workDir: directory,
        name: 'held',
        output,
        encode: (count, target) =>
          step(
            buildHeldScreenPictureArgs({
              imagePath: photo,
              output: target,
              width: 320,
              height: 320,
              frameRate,
              frames: count,
              fitMode: 'cover'
            }).map(argument =>
              // The compressor writes its pieces at one timescale; the stitcher writes them
              // at the source's. The assembly must hold for either.
              argument === '15360' ? String(timescale) : argument
            )
          ),
        runner: {
          ffmpeg: step,
          ffprobe: async args => {
            const probed = await runTool(ffprobePath, args, {});
            return toolSucceeded(probed) ? probed.stdout : null;
          }
        }
      });
      const elapsedMs = performance.now() - started;
      expect(result).toEqual({ step: 'ok', road: 'assembled' });
      // A seed, two probes and a handful of copies — never one process per piece.
      expect(spawned).toBeLessThanOrEqual(6);

      const table = await tool(ffprobePath, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts,dts,flags,size',
        '-of',
        'csv=p=0',
        output
      ]);
      const packets = table
        .split('\n')
        .filter(Boolean)
        .map(line => line.split(','))
        .map(([pts, dts, size, flags]) => ({
          pts: Number(pts),
          dts: Number(dts),
          size: Number(size),
          key: (flags ?? '').includes('K')
        }));
      expect(packets).toHaveLength(frames);
      // Constant means constant: picture N is at exactly N frame periods, on every tick.
      const ticks = timescale / frameRate;
      expect(packets.every((packet, index) => packet.pts === Math.round(index * ticks))).toBe(true);
      expect(packets.every(packet => packet.pts === packet.dts)).toBe(true);
      // A full picture where a group begins and nowhere else.
      const keys = packets.flatMap((packet, index) => (packet.key ? [index] : []));
      expect(keys).toEqual(
        Array.from(
          { length: Math.ceil(frames / HELD_PICTURE_GOP_FRAMES) },
          (_, index) => index * HELD_PICTURE_GOP_FRAMES
        )
      );
      // Everything else is an empty repeat, and small enough to say so.
      const repeats = packets.filter(packet => !packet.key);
      expect(Math.max(...repeats.map(packet => packet.size))).toBeLessThan(64);

      // It decodes without a single complaint, and every frame of it is the same picture.
      const hashes = await tool(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        '-i',
        output,
        '-map',
        '0:v',
        '-f',
        'framemd5',
        '-'
      ]);
      const pictures = new Set(
        hashes
          .split('\n')
          .filter(line => line && !line.startsWith('#'))
          .map(line => line.split(',').at(-1)?.trim())
      );
      expect(pictures.size).toBe(1);
      console.info('held picture', {
        frameRate,
        frames,
        elapsedMs: Math.round(elapsedMs),
        bytes: (await stat(output)).size,
        spawned
      });
    },
    120_000
  );
});
