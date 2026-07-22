import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationSupportRoot } from '../files/support-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// When packaged the compiled JS and the bundled runtime sit at the same
// relative offset as the ffmpeg binaries (see ffmpeg/tools.ts). In a source or
// `node dist` run the model lives in the repo at apps/agent/runtime/models.
const packagedRuntime = path.resolve(here, '../../../runtime');
const localRuntime = path.resolve(here, '../../runtime');

/** whisper.cpp CLI: the bundled binary when packaged, otherwise on PATH. */
export const whisperPath =
  process.env.WHISPER_PATH ??
  (process.env.PACKAGED_APP === '1'
    ? path.join(packagedRuntime, 'bin', 'whisper-cli')
    : 'whisper-cli');

/** Models shipped inside the app bundle / repo runtime (VAD lives here). */
const bundledModelsDir = path.join(
  process.env.PACKAGED_APP === '1' ? packagedRuntime : localRuntime,
  'models'
);
/** Writable location for the on-demand model download (bundle is read-only). */
const downloadModelsDir = path.join(applicationSupportRoot(), 'models');

/** The large model is fetched on first use to keep the installer small. */
export const MODEL_DESCRIPTOR = {
  label: 'large-v3',
  fileName: 'ggml-large-v3.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
  sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  sizeBytes: 3095033483
} as const;

/** Absolute path the on-demand download writes to (App Support, writable). */
export function downloadedModelPath(): string {
  return path.join(downloadModelsDir, MODEL_DESCRIPTOR.fileName);
}

/**
 * Multilingual speech model (99 langs). Prefer the full large-v3, then the
 * smaller turbo build, checking the writable download dir before the bundle.
 * Returns the canonical download target when nothing is present yet.
 */
export function currentModelPath(): string {
  if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH;
  const candidates = [
    path.join(downloadModelsDir, 'ggml-large-v3.bin'),
    path.join(bundledModelsDir, 'ggml-large-v3.bin'),
    path.join(downloadModelsDir, 'ggml-large-v3-turbo.bin'),
    path.join(bundledModelsDir, 'ggml-large-v3-turbo.bin')
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return downloadedModelPath();
}

/** True when a usable model file already exists (bundled or downloaded). */
export function modelPresent(): boolean {
  if (process.env.WHISPER_MODEL_PATH) return existsSync(process.env.WHISPER_MODEL_PATH);
  return [
    path.join(downloadModelsDir, 'ggml-large-v3.bin'),
    path.join(bundledModelsDir, 'ggml-large-v3.bin'),
    path.join(downloadModelsDir, 'ggml-large-v3-turbo.bin'),
    path.join(bundledModelsDir, 'ggml-large-v3-turbo.bin')
  ].some(existsSync);
}

/**
 * Silero VAD model. When present, whisper only runs on detected speech, which
 * prevents the classic "hallucinated text on trailing silence" loop. It is tiny
 * (~0.9 MB) so it always ships in the bundle rather than being downloaded.
 */
export const whisperVadModelPath =
  process.env.WHISPER_VAD_MODEL_PATH ?? path.join(bundledModelsDir, 'ggml-silero-v5.1.2.bin');

export class WhisperUnavailableError extends Error {
  readonly code = 'WHISPER_UNAVAILABLE';
  constructor(
    readonly reason: 'binary' | 'model',
    readonly causeCode: string | null = null
  ) {
    super(`WHISPER_${reason.toUpperCase()}_UNAVAILABLE${causeCode ? ` (${causeCode})` : ''}`);
    this.name = 'WhisperUnavailableError';
  }
}

/** Resolves true when the whisper binary can be launched. */
export async function whisperAvailable(command = whisperPath): Promise<boolean> {
  return new Promise(resolve => {
    // whisper-cli exits non-zero with no args but prints usage; `--help` is the
    // portable "am I runnable" probe that mirrors commandExists for ffmpeg.
    const child = spawn(command, ['--help'], { shell: false, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', () => resolve(true));
  });
}
