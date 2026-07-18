import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EncodingSettings } from '@video-compressor/shared';
import { buildFfmpegArgs } from './presets.js';
import { ffmpegPath } from './tools.js';

export interface EncodeResult {
  code: number | null;
  stderr: string;
  cancelled: boolean;
}

export function encodeVideo(
  input: string,
  output: string,
  duration: number | null,
  settings: EncodingSettings,
  transcodeAudio: boolean,
  onProgress: (value: number | null) => void
): { child: ChildProcessWithoutNullStreams; done: Promise<EncodeResult> } {
  const args = buildFfmpegArgs(input, output, settings, transcodeAudio);
  const child = spawn(ffmpegPath, args, { shell: false });
  let stderr = '';
  let buffer = '';
  let cancelled = false;

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const [key, raw] = line.trim().split('=', 2);
      if (key === 'out_time_us' && duration) {
        onProgress(Math.min(99.9, (Number(raw) / 1_000_000 / duration) * 100));
      }
      if (key === 'progress' && raw === 'end') onProgress(100);
    }
  });
  child.stderr.on('data', data => {
    stderr = (stderr + data.toString()).slice(-12_000);
  });
  child.once('error', error => {
    stderr += error.message;
  });
  child.once('spawn', () => {
    cancelled = false;
  });
  const done = new Promise<EncodeResult>(resolve =>
    child.once('close', code => resolve({ code, stderr, cancelled }))
  );
  return { child, done };
}

export function isAudioCopyFailure(stderr: string): boolean {
  return /codec.*not currently supported in container|could not find tag for codec|audio.*not supported|muxer does not support/i.test(
    stderr
  );
}
