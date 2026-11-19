import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHeldPicture, type HeldStep } from '../apps/agent/src/ffmpeg/held-picture.js';
import { buildHeldScreenPictureArgs } from '../apps/agent/src/ffmpeg/presets.js';
import { ffmpegPath, ffprobePath } from '../apps/agent/src/ffmpeg/tools.js';
import {
  repeatIndexFromProbe,
  repeatPacketLimit,
  repeatedPictureTime,
  staticEdgeScan
} from '../apps/agent/src/images/static-edges.js';
import * as managedSpawn from '../apps/agent/src/power/spawn.js';
import { runTool, toolSucceeded } from '../apps/agent/src/stitcher/run.js';
import { describeRequiring } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { ffmpegBinaries } from './support/toolchain.js';

/*
 * A held screen at the body's frame rate is one full picture and thousands of empty repeats.
 * Seeking deep into it makes the decoder walk every repeat since the last full picture, and
 * the edge search asks for dozens of frames. The packet sizes already say which frames are
 * repeats of which picture, so the search decodes the picture instead of the walk.
 */

/** ffprobe's table: a 1080×1080 stream, a moving body, then a picture and its repeats. */
function table(lines: string[]): string {
  return `${lines.join('\n')}\nstream,1080,1080\n`;
}
const packet = (time: number, size: number, key = false) =>
  `packet,${time.toFixed(6)},${size},${key ? 'K__' : '___'}`;

describe('reading repeats from packet sizes', () => {
  it('allows only what skipped macroblocks can cost', () => {
    // Measured: 43 bytes at 1080×1080 with CABAC. One changed macroblock costs more.
    expect(repeatPacketLimit(1080, 1080)).toBe(89);
    expect(repeatPacketLimit(1920, 1080)).toBe(144);
    expect(repeatPacketLimit(320, 320)).toBe(23);
  });

  it('maps every repeat back to the picture its run began with', () => {
    const index = repeatIndexFromProbe(
      table([
        packet(0, 9000, true),
        packet(1 / 30, 2400),
        packet(2 / 30, 2100),
        packet(3 / 30, 52000, true),
        packet(4 / 30, 43),
        packet(5 / 30, 43),
        packet(6 / 30, 43)
      ])
    );
    expect(index).not.toBeNull();
    const half = 0.5 / 30;
    // Moving frames are their own pictures.
    expect(repeatedPictureTime(index!, 1 / 30, half)).toBeNull();
    // So is the picture a run begins with: it is decoded, not looked up.
    expect(repeatedPictureTime(index!, 3 / 30, half)).toBeNull();
    // And every repeat after it is that picture.
    for (const frame of [4, 5, 6])
      expect(repeatedPictureTime(index!, frame / 30, half)).toBeCloseTo(3 / 30, 6);
    // Past the last picture nothing is answered: the decoder decides, as it always did.
    expect(repeatedPictureTime(index!, 9 / 30, half)).toBeNull();
  });

  it('ends a run at a frame that is not the same size as its repeats', () => {
    const index = repeatIndexFromProbe(
      table([
        packet(0, 52000, true),
        packet(1 / 30, 43),
        packet(2 / 30, 43),
        // Small, but not a repeat like the others: something in it changed.
        packet(3 / 30, 70),
        packet(4 / 30, 43)
      ])
    );
    const half = 0.5 / 30;
    expect(repeatedPictureTime(index!, 2 / 30, half)).toBeCloseTo(0, 6);
    expect(repeatedPictureTime(index!, 3 / 30, half)).toBeNull();
    // What follows repeats the changed frame, not the picture before it.
    expect(repeatedPictureTime(index!, 4 / 30, half)).toBeCloseTo(3 / 30, 6);
  });

  it('never treats reordered frames as repeats', () => {
    // A B-frame arrives after the frame it is shown before; a copy-of-the-previous-frame
    // reading of it would be a guess.
    const index = repeatIndexFromProbe(
      table([packet(0, 9000, true), packet(3 / 30, 40), packet(1 / 30, 40), packet(2 / 30, 40)])
    );
    const half = 0.5 / 30;
    expect(repeatedPictureTime(index!, 1 / 30, half)).toBeNull();
  });

  it('has nothing to say about a file with no repeats, or one it cannot read', () => {
    expect(
      repeatIndexFromProbe(
        table([packet(0, 9000, true), packet(1 / 30, 2000), packet(2 / 30, 1800)])
      )
    ).toBeNull();
    expect(repeatIndexFromProbe('')).toBeNull();
    expect(repeatIndexFromProbe('packet,0.000000,43,K__\npacket,0.033333,43,___\n')).toBeNull();
  });
});

let directory = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function ffmpeg(args: string[]) {
  const result = await runTool(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    {}
  );
  if (!toolSucceeded(result)) throw new Error(result.stderr);
}

describeRequiring(ffmpegBinaries, 'the edge search on a screen held at the body rate', () => {
  it('finds a five-minute screen without walking its repeats', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'static-edge-repeats-'));
    const frameRate = 30;
    const bodySeconds = 4;
    const screenFrames = 9500;
    const photo = path.join(directory, 'photo.png');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1', '-frames:v', '1', photo]);
    const body = path.join(directory, 'body.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `mandelbrot=size=320x320:rate=${frameRate}`,
      '-t',
      String(bodySeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-bf',
      '0',
      '-video_track_timescale',
      '15360',
      body
    ]);
    const screen = path.join(directory, 'screen.mp4');
    const step = async (args: string[]): Promise<HeldStep> =>
      toolSucceeded(await runTool(ffmpegPath, args, {})) ? 'ok' : 'failed';
    const built = await buildHeldPicture({
      frames: screenFrames,
      frameRate,
      timescale: 15360,
      workDir: directory,
      name: 'held',
      output: screen,
      encode: (frames, output) =>
        step(
          buildHeldScreenPictureArgs({
            imagePath: photo,
            output,
            width: 320,
            height: 320,
            frameRate,
            frames,
            fitMode: 'cover'
          })
        ),
      runner: {
        ffmpeg: step,
        ffprobe: async args => {
          const probed = await runTool(ffprobePath, args, {});
          return toolSucceeded(probed) ? probed.stdout : null;
        }
      }
    });
    expect(built).toEqual({ step: 'ok', road: 'assembled' });
    const list = path.join(directory, 'list.txt');
    await writeFile(list, `file '${body}'\nfile '${screen}'\n`, 'utf8');
    const input = path.join(directory, 'stitched.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', input]);

    const durationSeconds = bodySeconds + screenFrames / frameRate;
    const launches = vi.spyOn(managedSpawn, 'spawnTracked');
    const started = performance.now();
    const trims = await staticEdgeScan(input, durationSeconds, frameRate).trims();
    const elapsedMs = performance.now() - started;
    const decodes = launches.mock.calls.length;
    launches.mockRestore();
    console.info('edge search over a held screen', { elapsedMs: Math.round(elapsedMs), decodes });

    // The whole screen, to the frame, and nothing of the moving body.
    expect(trims.startSeconds).toBeLessThan(0.2);
    expect(Math.abs(trims.endSeconds - screenFrames / frameRate)).toBeLessThanOrEqual(
      1.5 / frameRate
    );
    /*
     * The search asks about some thirty frames; all but a handful sit inside the screen and
     * are one picture. Decoding each would be a walk of up to nine thousand repeats apiece.
     */
    expect(decodes).toBeLessThan(16);
  }, 120_000);
});
