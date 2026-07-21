import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EncodingSettings, JobImageEmbedding } from '@video-compressor/shared';
import { buildEmbeddedFfmpegArgs, buildFfmpegArgs } from './presets.js';
import { ffmpegPath } from './tools.js';

export interface EncodeResult {
  code: number | null;
  stderr: string;
  cancelled: boolean;
  spawnErrorCode: string | null;
}

export interface EncodeEmbeddingOptions {
  sourceDurationSeconds: number;
  sourceHasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  imageEmbedding: JobImageEmbedding;
  startImagePath: string | null;
  endImagePath: string | null;
}

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
  embedding?: EncodeEmbeddingOptions
): { child: ChildProcessWithoutNullStreams; done: Promise<EncodeResult> } {
  const args = embedding
    ? buildEmbeddedFfmpegArgs({ input, output, settings, ...embedding })
    : buildFfmpegArgs(input, output, settings, transcodeAudio);
  const child = spawn(ffmpegPath, args, { shell: false });
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

export function isAudioCopyFailure(stderr: string): boolean {
  return /codec.*not currently supported in container|could not find tag for codec|audio.*not supported|muxer does not support/i.test(
    stderr
  );
}
