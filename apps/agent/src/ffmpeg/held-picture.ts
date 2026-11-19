/**
 * A held picture at the body's own frame rate, without encoding every frame of it.
 *
 * Why the rate matters. A held screen used to be a few hundred pictures spread over as much
 * as an hour, because the cost of a screen is its frame count. That made every finished file
 * variable-rate with an average of one to five frames a second, and Facebook re-encodes an
 * upload to a constant rate it derives from that average: a three-minute, sixty-frame
 * creative under a forty-minute screen averaged 4.46 and came back as five frames a second —
 * a slideshow (docs/incidents/2026-11-19-facebook-low-fps.md). The same file with the screen
 * at the body's rate came back at thirty. So the screen now carries one picture per frame
 * period, like the body it follows.
 *
 * Why it is still cheap. With every picture after the first forced to the coarsest
 * quantiser, x264 writes them as empty repeats — forty-odd bytes each at 1080p — and those
 * repeats are byte-identical with a short period, because nothing in them changes but a
 * four-bit frame counter. So a short seed is encoded once, its period is *measured* rather
 * than assumed, and the screen is assembled from two pieces of that seed by stream copy:
 * the picture followed by one period of repeats, and one period of repeats alone. The
 * result is the stream x264 would have written had it been left running, at the cost of two
 * hundred frames.
 *
 * Why the picture comes back every few minutes. A decoder can only start at a full picture,
 * so the distance between them is what a seek into the screen costs; but a full picture of a
 * detailed photograph is half a megabyte, and one a minute would outweigh the body. Nine
 * thousand frames apart keeps a seek under two seconds and the pictures a small part of the
 * screen's size.
 *
 * Every step that could be wrong falls back to encoding the screen frame by frame: slower,
 * and always correct. The short road may only ever save time.
 */

import path from 'node:path';
import { writeFile } from 'node:fs/promises';

/** Frames between two full pictures inside a held screen. */
export const HELD_PICTURE_GOP_FRAMES = 9000;
/** A screen this short is simply encoded; assembling it would cost more than it saves. */
export const HELD_PICTURE_DIRECT_FRAMES = 600;
/** The picture, three of the longest period we accept, and the encoder's uneven last frames. */
export const HELD_PICTURE_SEED_FRAMES = 209;
/**
 * Quality of the one picture everything else repeats.
 *
 * The sparse screen got a very low quantiser for free, because x264 scales its rate factor
 * by how long a frame is shown. At the body's rate that help is gone, so it is asked for.
 */
export const HELD_PICTURE_CRF = 15;

/**
 * What a held screen of `frames` pictures weighs, from its two kinds of packet.
 *
 * Exact rather than a rate: the screen is one full picture per group and an empty repeat for
 * every other frame, so its size is those two numbers and a count — which is what lets the
 * compressor say what a forty-minute image will cost before it is built.
 */
export function heldPictureBytes(pictureBytes: number, repeatBytes: number, frames: number) {
  const count = Math.max(0, Math.round(frames));
  return Math.ceil(count / HELD_PICTURE_GOP_FRAMES) * pictureBytes + count * repeatBytes;
}

const PERIODS = [16, 32, 64] as const;
/** The encoder's lookahead makes the last few frames of any run differ; never compare them. */
const SEED_END_GUARD = 16;
const BLOCK_CYCLES = 32;
const BASE = ['-hide_banner', '-nostdin', '-y'] as const;

export type HeldStep = 'ok' | 'failed' | 'cancelled';

export interface HeldPictureRunner {
  ffmpeg(args: string[]): Promise<HeldStep>;
  /** ffprobe's stdout, or null when it could not be read. */
  ffprobe(args: string[]): Promise<string | null>;
}

function decimal(value: number, maximumFractionDigits = 9): string {
  return Number(value.toFixed(maximumFractionDigits)).toString();
}

/**
 * An FFconcat list of working files, quoted by the demuxer's own rule.
 *
 * The same rule `concatListContents` applies; restated here because the stitcher's argument
 * builders take their encoder arguments from this module, and the two must not import each
 * other.
 */
function repeatListContents(paths: readonly string[]): string {
  return `${paths.map(value => `file '${value.replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}

/**
 * The x264 arguments that turn every picture after the first into an empty repeat.
 *
 * `zones` forces the quantiser of frames 1…N to 51, where an unchanged macroblock costs
 * nothing to skip and nothing is left to refine. Without it x264 keeps improving a still
 * for as long as it is given frames — about half a kilobyte each, which over a
 * forty-minute screen is more than the body.
 */
export function heldPictureEncoderArgs(frames: number): string[] {
  return ['-x264-params', `zones=1,${Math.max(1, Math.round(frames) - 1)},q=51`];
}

export function buildPacketHashProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_data_hash',
    'md5',
    '-show_entries',
    'packet=size,flags,data_hash',
    '-of',
    'csv=p=0',
    input
  ];
}

interface HashedPacket {
  size: number;
  key: boolean;
  hash: string;
}

export function parsePacketHashes(stdout: string): HashedPacket[] {
  const packets: HashedPacket[] = [];
  for (const line of stdout.split('\n')) {
    const [size, flags, hash] = line.trim().split(',');
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || !flags || !hash) continue;
    packets.push({ size: bytes, key: flags.includes('K'), hash });
  }
  return packets;
}

export interface HeldSeedShape {
  /** After how many repeats the encoder's output is byte-for-byte the same again. */
  period: number;
  pictureBytes: number;
  repeatBytes: number;
  /** The hashes of one period of repeats, to check the cut against. */
  cycle: string[];
}

/**
 * Whether a seed is what the assembly assumes: one picture, then repeats with a period.
 *
 * Measured, never assumed. The period follows from how the encoder numbers frames and marks
 * references, which is its business and could change with a build; a seed that does not
 * repeat cleanly returns null and the screen is encoded the long way.
 */
export function heldSeedShape(stdout: string): HeldSeedShape | null {
  const packets = parsePacketHashes(stdout);
  const first = packets[0];
  if (!first || !first.key) return null;
  if (packets.slice(1).some(packet => packet.key)) return null;
  for (const period of PERIODS) {
    if (packets.length < 1 + 3 * period + SEED_END_GUARD) continue;
    let periodic = true;
    for (let index = 1; index <= 2 * period; index += 1) {
      if (packets[index]!.hash !== packets[index + period]!.hash) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    const cycle = packets.slice(period + 1, 2 * period + 1);
    return {
      period,
      pictureBytes: first.size,
      repeatBytes: Math.max(...cycle.map(packet => packet.size)),
      cycle: cycle.map(packet => packet.hash)
    };
  }
  return null;
}

export interface HeldCutOptions {
  seedPath: string;
  headPath: string;
  cyclePath: string;
  period: number;
  frameRate: number;
  timescale: number;
}

/**
 * The two pieces, cut from the seed in one run.
 *
 * The head is the picture and one whole period after it, so whatever follows it starts
 * where the period starts. The cycle is the next period on its own — a file with no
 * keyframe in it, which is exactly what it has to be, and what `-copyinkf` allows.
 */
export function buildHeldCutArgs(options: HeldCutOptions): string[] {
  const { period, frameRate } = options;
  const timescale = String(options.timescale);
  return [
    ...BASE,
    '-i',
    options.seedPath,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-frames:v',
    String(period + 1),
    '-video_track_timescale',
    timescale,
    options.headPath,
    '-map',
    '0:v:0',
    // Half a frame early: the cut must land between two pictures, never on a rounding edge.
    '-ss',
    decimal((period + 0.5) / frameRate),
    '-c',
    'copy',
    '-copyinkf',
    '-frames:v',
    String(period),
    '-avoid_negative_ts',
    'make_zero',
    '-video_track_timescale',
    timescale,
    options.cyclePath
  ];
}

export interface HeldRepeatOptions {
  listPath: string;
  output: string;
  frames: number;
  timescale: number;
  /** Set on the last assembly only: restamps every picture on the exact frame grid. */
  retimeFrameRate?: number;
}

/**
 * Pieces joined end to end by stream copy, cut to an exact number of pictures.
 *
 * The concat demuxer places each piece by the previous one's duration in microseconds, and
 * a thirty-two-frame piece is not a whole number of them, so a join can land a tick late.
 * The last assembly therefore restamps by counting: picture N is at N frame periods, which
 * is what "constant" means and what every later probe of the file will measure.
 */
export function buildHeldRepeatArgs(options: HeldRepeatOptions): string[] {
  const step =
    options.retimeFrameRate && options.retimeFrameRate > 0
      ? decimal(options.timescale / options.retimeFrameRate, 12)
      : null;
  return [
    ...BASE,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    options.listPath,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    // A block of repeats has no keyframe at all, and a copy otherwise waits for one.
    '-copyinkf',
    ...(step
      ? ['-bsf:v', `setts=ts=round(N*${step}):duration=round((N+1)*${step})-round(N*${step})`]
      : []),
    '-frames:v',
    String(options.frames),
    '-an',
    '-video_track_timescale',
    String(options.timescale),
    options.output
  ];
}

export interface HeldPictureOptions {
  frames: number;
  frameRate: number;
  timescale: number;
  /** A directory the caller owns and removes. */
  workDir: string;
  /** Name stem, so two screens built side by side never collide. */
  name: string;
  output: string;
  /** Encodes `frames` identical pictures to `output` with the caller's own arguments. */
  encode(frames: number, output: string): Promise<HeldStep>;
  runner: HeldPictureRunner;
}

export interface HeldPictureResult {
  step: HeldStep;
  /** How the screen was made, for the timings a run records. */
  road: 'direct' | 'assembled' | 'fallback';
}

export async function buildHeldPicture(options: HeldPictureOptions): Promise<HeldPictureResult> {
  const frames = Math.round(options.frames);
  if (frames <= HELD_PICTURE_DIRECT_FRAMES)
    return { step: await options.encode(frames, options.output), road: 'direct' };

  const assembled = await assemble(options, frames);
  if (assembled === 'ok') return { step: 'ok', road: 'assembled' };
  if (assembled === 'cancelled') return { step: 'cancelled', road: 'assembled' };
  return { step: await options.encode(frames, options.output), road: 'fallback' };
}

async function assemble(options: HeldPictureOptions, frames: number): Promise<HeldStep> {
  const { runner, timescale, frameRate } = options;
  const file = (suffix: string) => path.join(options.workDir, `${options.name}-${suffix}`);
  try {
    const seedPath = file('seed.mp4');
    const seeded = await options.encode(HELD_PICTURE_SEED_FRAMES, seedPath);
    if (seeded !== 'ok') return seeded;

    const seedHashes = await runner.ffprobe(buildPacketHashProbeArgs(seedPath));
    const shape = seedHashes === null ? null : heldSeedShape(seedHashes);
    if (!shape) return 'failed';
    const { period } = shape;

    const headPath = file('head.mp4');
    const cyclePath = file('cycle.mp4');
    const cut = await runner.ffmpeg(
      buildHeldCutArgs({ seedPath, headPath, cyclePath, period, frameRate, timescale })
    );
    if (cut !== 'ok') return cut;
    // The cut is trusted only once the cycle is, byte for byte, the period that was measured.
    const cycleHashes = await runner.ffprobe(buildPacketHashProbeArgs(cyclePath));
    const cycle = cycleHashes === null ? [] : parsePacketHashes(cycleHashes);
    if (
      cycle.length !== period ||
      cycle.some((packet, index) => packet.key || packet.hash !== shape.cycle[index])
    )
      return 'failed';

    const join = async (
      suffix: string,
      pieces: string[],
      count: number,
      output: string,
      last: boolean
    ): Promise<HeldStep> => {
      const listPath = file(`${suffix}.txt`);
      await writeFile(listPath, repeatListContents(pieces), 'utf8');
      return runner.ffmpeg(
        buildHeldRepeatArgs({
          listPath,
          output,
          frames: count,
          timescale,
          ...(last ? { retimeFrameRate: frameRate } : {})
        })
      );
    };

    const gopFrames = Math.min(frames, HELD_PICTURE_GOP_FRAMES);
    const single = frames <= gopFrames;
    const cyclesNeeded = Math.max(0, Math.ceil((gopFrames - (period + 1)) / period));
    let repeatPath = cyclePath;
    let repeatsNeeded = cyclesNeeded;
    if (cyclesNeeded > BLOCK_CYCLES * 2) {
      // One level between, so no list ever names a file thousands of times.
      const blockPath = file('block.mp4');
      const block = await join(
        'block',
        Array<string>(BLOCK_CYCLES).fill(cyclePath),
        BLOCK_CYCLES * period,
        blockPath,
        false
      );
      if (block !== 'ok') return block;
      repeatPath = blockPath;
      repeatsNeeded = Math.ceil(cyclesNeeded / BLOCK_CYCLES);
    }
    const gopPath = single ? options.output : file('gop.mp4');
    const gop = await join(
      'gop',
      [headPath, ...Array<string>(repeatsNeeded).fill(repeatPath)],
      gopFrames,
      gopPath,
      single
    );
    if (gop !== 'ok' || single) return gop;

    return await join(
      'screen',
      Array<string>(Math.ceil(frames / gopFrames)).fill(gopPath),
      frames,
      options.output,
      true
    );
  } catch {
    return 'failed';
  }
}
