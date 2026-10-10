import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { scaled, spawnTracked } from '../power/spawn.js';

/**
 * The decoded-audio fingerprint of a video (012, T004).
 *
 * A hash of what the file *sounds like*, not of its bytes: the first audio stream decoded to
 * 16 kHz mono signed 16-bit PCM and run through SHA-256. A re-wrapped copy (another container,
 * the same audio stream) hashes the same, so the space can tell that two files carry the same
 * speech and reuse one transcript for both (FR-T2). A re-encoded copy does not — lossy audio
 * decodes to different samples — which is why a compression carries its transcript along
 * explicitly instead of relying on this.
 *
 * Never throws. A file with no audio, an ffmpeg that refuses it, a cancel or a run that takes
 * too long all answer `null`: the transcript is worth having without a fingerprint, and the
 * server treats a missing one as "unknown".
 */
export interface AudioFingerprintOptions {
  file: string;
  signal?: AbortSignal;
  /** Upper bound on the decode, before the resource limit stretches it. */
  timeoutMs?: number;
  /** For tests: what starts the decoder. Defaults to the bundled ffmpeg under the governor. */
  spawnChild?: (command: string, args: readonly string[]) => ChildProcess;
  command?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function audioFingerprintArgs(file: string): string[] {
  return [
    '-nostdin',
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    's16le',
    '-threads',
    '1',
    '-bitexact',
    'pipe:1'
  ];
}

export function audioFingerprint(options: AudioFingerprintOptions): Promise<string | null> {
  const { file, signal } = options;
  if (signal?.aborted) return Promise.resolve(null);
  const command = options.command ?? ffmpegPath;
  const args = audioFingerprintArgs(file);
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = options.spawnChild
        ? options.spawnChild(command, args)
        : spawnTracked(command, args, {
            toolId: 'audio-fingerprint',
            stdio: ['ignore', 'pipe', 'ignore']
          });
    } catch {
      resolve(null);
      return;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(null);
    };
    const timer = setTimeout(abort, scaled(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.once('error', () => finish(null));
    child.once('close', code => {
      // No samples is no audio: a hash of nothing would match every silent file.
      finish(code === 0 && bytes > 0 ? hash.digest('hex') : null);
    });
  });
}
