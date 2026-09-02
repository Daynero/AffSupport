import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EncodingSettings, JobImageEmbedding } from '@video-compressor/shared';
import { activeGovernorOrNull, spawnManaged, type ManagedSpawnGovernor } from '../power/spawn.js';
import {
  buildEmbeddedFfmpegArgs,
  buildFfmpegArgs,
  buildHeldScreenArgs,
  heldFinalImageSeconds
} from './presets.js';
import { buildConcatArgs, concatListContents } from './stitch-presets.js';
import { ffmpegPath } from './tools.js';

export interface EncodeResult {
  code: number | null;
  stderr: string;
  cancelled: boolean;
  spawnErrorCode: string | null;
}

export interface EncodeEmbeddingOptions {
  sourceStartSeconds: number;
  sourceDurationSeconds: number;
  sourceHasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  imageEmbedding: JobImageEmbedding;
  startImagePath: string | null;
  endImagePath: string | null;
}

/** The video track timescale both halves of a join are written with. */
const JOIN_TIMESCALE = 15360;

export function calculateEncodeProgress(outTimeUs: number, durationSeconds: number | null) {
  if (!durationSeconds || durationSeconds <= 0 || !Number.isFinite(outTimeUs)) return null;
  return Math.min(99.9, Math.max(0, (outTimeUs / 1_000_000 / durationSeconds) * 100));
}

export function encodeVideo(
  input: string,
  output: string,
  duration: number | null,
  settings: EncodingSettings,
  transcodeAudio: boolean,
  onProgress: (value: number | null) => void,
  embedding?: EncodeEmbeddingOptions,
  // The explicit governor keeps assembled queues isolated in tests. Deep
  // callers may omit it and inherit the process-wide budget, so no encode can
  // silently escape measurement and throttling merely because an intermediate
  // call site forgot to thread the dependency through.
  governor: ManagedSpawnGovernor | null = activeGovernorOrNull(),
  // Each pass in turn, so whoever holds the job can still reach the running child.
  onChild?: (child: ChildProcessWithoutNullStreams) => void
): { child: ChildProcessWithoutNullStreams; done: Promise<EncodeResult> } {
  const threads = governor?.budget().threadBudget ?? null;
  const held = embedding?.endImagePath
    ? heldFinalImageSeconds(embedding.imageEmbedding, embedding.frameRate)
    : null;
  if (embedding && embedding.endImagePath && held !== null) {
    return encodeWithHeldScreen({
      input,
      output,
      settings,
      threads,
      onProgress,
      embedding,
      heldSeconds: held,
      governor,
      onChild
    });
  }
  const args = embedding
    ? buildEmbeddedFfmpegArgs({ input, output, settings, threads, ...embedding })
    : buildFfmpegArgs(input, output, settings, transcodeAudio, threads);
  const child = spawnManaged(governor ?? null, ffmpegPath, args, {
    toolId: 'compressor'
  }) as ChildProcessWithoutNullStreams;
  let stderr = '';
  let buffer = '';
  let cancelled = false;
  let spawnErrorCode: string | null = null;

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const [key, raw] = line.trim().split('=', 2);
      if (key === 'out_time_us') {
        const progress = calculateEncodeProgress(Number(raw), duration);
        if (progress !== null) onProgress(progress);
      }
      if (key === 'progress' && raw === 'end') onProgress(100);
    }
  });
  child.stderr.on('data', data => {
    stderr = (stderr + data.toString()).slice(-12_000);
  });
  child.once('error', error => {
    spawnErrorCode = 'code' in error && typeof error.code === 'string' ? error.code : null;
    stderr += error.message;
  });
  child.once('spawn', () => {
    cancelled = false;
  });
  const done = new Promise<EncodeResult>(resolve =>
    child.once('close', code => resolve({ code, stderr, cancelled, spawnErrorCode }))
  );
  return { child, done };
}

/**
 * The same output, in three passes instead of one.
 *
 * The body (and the one-frame opening image, which costs nothing) is encoded exactly as it
 * always was. The held final image is built as its own segment — a few hundred pictures
 * rather than one per frame period — and the two are joined by the concat demuxer with a
 * stream copy. Measured on a two-minute creative with a forty-five-minute image: seven
 * hundred seconds before, sixty-six after, and the time no longer grows with the image.
 *
 * Three passes rather than one branch of the filter graph because a graph that joins them
 * writes a video track two picture-intervals shorter than its own audio, and the compressor
 * rejects that file itself. A segment carries its duration in its own container.
 */
function encodeWithHeldScreen(options: {
  input: string;
  output: string;
  settings: EncodingSettings;
  threads: number | null;
  onProgress: (value: number | null) => void;
  embedding: EncodeEmbeddingOptions;
  heldSeconds: number;
  governor: ManagedSpawnGovernor | null;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
}): { child: ChildProcessWithoutNullStreams; done: Promise<EncodeResult> } {
  const { embedding, settings, threads, governor } = options;
  /* Progress is measured against the body alone: it is what takes the time, and a bar scaled
     to a forty-five-minute image would stop at three percent and sit there. */
  const bodySeconds =
    embedding.sourceDurationSeconds +
    (embedding.startImagePath ? 1 / Math.max(1, embedding.frameRate) : 0);
  const body = spawnPass(
    governor,
    buildEmbeddedFfmpegArgs({
      input: options.input,
      // Written beside the final file rather than into it: nothing may appear at the output
      // path until the join has succeeded.
      output: `${options.output}.body.mp4`,
      settings,
      threads,
      ...embedding,
      endImagePath: null,
      videoTrackTimescale: JOIN_TIMESCALE
    }),
    bodySeconds,
    options.onProgress
  );
  options.onChild?.(body.child);

  const done = (async (): Promise<EncodeResult> => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'soty-held-'));
    const bodyPath = `${options.output}.body.mp4`;
    try {
      const first = await body.done;
      if (first.code !== 0 || first.cancelled || first.spawnErrorCode) return first;

      const screenPath = path.join(workDir, 'screen.mp4');
      const screen = spawnPass(
        governor,
        buildHeldScreenArgs({
          imagePath: embedding.endImagePath as string,
          output: screenPath,
          width: embedding.width,
          height: embedding.height,
          frameRate: embedding.frameRate,
          durationSeconds: options.heldSeconds,
          fitMode: embedding.imageEmbedding.fitMode,
          settings,
          threads
        }),
        null,
        () => {}
      );
      options.onChild?.(screen.child);
      const second = await screen.done;
      if (second.code !== 0 || second.cancelled || second.spawnErrorCode) return second;

      const listPath = path.join(workDir, 'segments.txt');
      await writeFile(listPath, concatListContents([bodyPath, screenPath]), 'utf8');
      const join = spawnPass(
        governor,
        buildConcatArgs({ listPath, output: options.output }),
        null,
        () => {}
      );
      options.onChild?.(join.child);
      const third = await join.done;
      if (third.code === 0) options.onProgress(100);
      return third;
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(bodyPath, { force: true });
    }
  })();

  return { child: body.child, done };
}

/** One FFmpeg run, with the same progress parsing and the same failure shape as the rest. */
function spawnPass(
  governor: ManagedSpawnGovernor | null,
  args: string[],
  duration: number | null,
  onProgress: (value: number | null) => void
): { child: ChildProcessWithoutNullStreams; done: Promise<EncodeResult> } {
  const child = spawnManaged(governor ?? null, ffmpegPath, args, {
    toolId: 'compressor'
  }) as ChildProcessWithoutNullStreams;
  let stderr = '';
  let buffer = '';
  let spawnErrorCode: string | null = null;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const [key, raw] = line.trim().split('=', 2);
      if (key === 'out_time_us') {
        const progress = calculateEncodeProgress(Number(raw), duration);
        if (progress !== null) onProgress(progress);
      }
    }
  });
  child.stderr.on('data', data => {
    stderr = (stderr + data.toString()).slice(-12_000);
  });
  child.once('error', error => {
    spawnErrorCode = 'code' in error && typeof error.code === 'string' ? error.code : null;
    stderr += error.message;
  });
  const done = new Promise<EncodeResult>(resolve =>
    child.once('close', code => resolve({ code, stderr, cancelled: false, spawnErrorCode }))
  );
  return { child, done };
}

export function isAudioCopyFailure(stderr: string): boolean {
  return /codec.*not currently supported in container|could not find tag for codec|audio.*not supported|muxer does not support/i.test(
    stderr
  );
}
