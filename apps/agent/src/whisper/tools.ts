import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptionQualityMode } from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { executableName } from '../platform/platform.js';

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
    ? path.join(packagedRuntime, 'bin', executableName('whisper-cli'))
    : executableName('whisper-cli'));

/** Models shipped inside the app bundle / repo runtime (VAD lives here). */
const bundledModelsDir = path.join(
  process.env.PACKAGED_APP === '1' ? packagedRuntime : localRuntime,
  'models'
);
/** Writable location for the on-demand model download (bundle is read-only). */
const downloadModelsDir = path.join(applicationSupportRoot(), 'models');

/** One speech model: where it comes from and how it is verified. */
export interface WhisperModelDescriptor {
  readonly quality: TranscriptionQualityMode;
  readonly label: string;
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * The two speech models, fetched on first use so the installer stays small.
 *
 * Both are the same 99-language large-v3 family. The turbo build keeps the encoder and cuts
 * the decoder from 32 layers to four, and its 5-bit quantisation is what makes it fit on a
 * CPU-only Windows laptop as well as on Apple Silicon — at 574 MB it also turns the first
 * run from a three-gigabyte wait into a coffee break. The full model stays for the runs
 * where beam search over noisy speech earns its cost.
 */
export const WHISPER_MODELS: Record<TranscriptionQualityMode, WhisperModelDescriptor> = {
  fast: {
    quality: 'fast',
    label: 'large-v3-turbo',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    sizeBytes: 574_041_195
  },
  accurate: {
    quality: 'accurate',
    label: 'large-v3',
    fileName: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    sizeBytes: 3_095_033_483
  }
};

/** The full model; kept under its historical name for the code that predates the modes. */
export const MODEL_DESCRIPTOR = WHISPER_MODELS.accurate;

/** Absolute path the on-demand download of one model writes to (App Support, writable). */
export function downloadedModelPath(quality: TranscriptionQualityMode = 'accurate'): string {
  return path.join(downloadModelsDir, WHISPER_MODELS[quality].fileName);
}

/** Every place a model of this quality may sit, writable directory first. */
function modelCandidates(quality: TranscriptionQualityMode): string[] {
  const { fileName } = WHISPER_MODELS[quality];
  const candidates = [
    path.join(downloadModelsDir, fileName),
    path.join(bundledModelsDir, fileName)
  ];
  // An unquantised turbo build dropped in by hand (or shipped in a bundle) serves the fast
  // mode just as well; it is only larger.
  if (quality === 'fast') {
    candidates.push(
      path.join(downloadModelsDir, 'ggml-large-v3-turbo.bin'),
      path.join(bundledModelsDir, 'ggml-large-v3-turbo.bin')
    );
  }
  return candidates;
}

/**
 * The model file a run of this quality should load.
 *
 * `WHISPER_MODEL_PATH` overrides both modes — it exists for tests and for a developer who
 * wants one specific file — and otherwise the writable download is preferred over the
 * bundle. Returns the canonical download target when nothing is present yet.
 */
export function currentModelPath(quality: TranscriptionQualityMode = 'accurate'): string {
  if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH;
  for (const candidate of modelCandidates(quality)) if (existsSync(candidate)) return candidate;
  return downloadedModelPath(quality);
}

/** True when a usable model file of this quality already exists (bundled or downloaded). */
export function modelPresent(quality: TranscriptionQualityMode = 'accurate'): boolean {
  if (process.env.WHISPER_MODEL_PATH) return existsSync(process.env.WHISPER_MODEL_PATH);
  return modelCandidates(quality).some(existsSync);
}

/**
 * What a fresh install should default to.
 *
 * A machine that already holds the full model and not the turbo one was set up before the
 * modes existed; asking it to download another half gigabyte before it can do what it did
 * yesterday would read as a regression, so it keeps running the model it has.
 */
export function defaultQualityForInstalledModels(): TranscriptionQualityMode {
  return modelPresent('accurate') && !modelPresent('fast') ? 'accurate' : 'fast';
}

const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin';

/**
 * Silero VAD model. When present, whisper only runs on detected speech, which prevents the
 * classic "hallucinated text on trailing silence" loop. It is tiny (~0.9 MB) so it ships in
 * the bundle rather than being downloaded.
 *
 * Resolved the same way the speech model is — writable directory first, then the bundle —
 * because `apps/agent/runtime/` exists only in a packaged app. A run from source therefore
 * found nothing here and transcribed in the one configuration this application never ships:
 * no VAD at all, listening to every second of silence and free to invent text over it. The
 * environment the product is tested in must not be the one configuration it is never shipped
 * in, so a copy left in the writable models directory now counts.
 */
export function whisperVadModelPathOrNull(): string | null {
  if (process.env.WHISPER_VAD_MODEL_PATH) {
    return existsSync(process.env.WHISPER_VAD_MODEL_PATH)
      ? process.env.WHISPER_VAD_MODEL_PATH
      : null;
  }
  for (const candidate of [
    path.join(downloadModelsDir, VAD_MODEL_FILE),
    path.join(bundledModelsDir, VAD_MODEL_FILE)
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolves true when the whisper binary can be launched. */
export async function whisperAvailable(
  command = whisperPath,
  timeoutMs = 10_000
): Promise<boolean> {
  return new Promise(resolve => {
    // whisper-cli exits non-zero with no args but prints usage; `--help` is the
    // portable "am I runnable" probe that mirrors commandExists for ffmpeg. A
    // binary that starts and then dies — a missing dynamic library, a crash in
    // the Metal loader — used to count as runnable because it did close; only a
    // clean exit does now, and a probe that never returns is given up on.
    const child = spawn(command, ['--help'], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 && signal === null);
    });
  });
}

/**
 * A yes/no about the filesystem that is asked far more often than it changes.
 *
 * Model presence is read on every state broadcast — several times a second while a run
 * reports progress — and each read was a handful of blocking `stat` calls on the event
 * loop. The answer changes when a download finishes or a file is removed by hand, so it is
 * remembered for a few seconds and dropped the moment the code that changes it says so.
 */
export function memoizePresence(
  check: () => boolean,
  ttlMs = 5_000
): { (): boolean; invalidate(): void } {
  let value: boolean | null = null;
  let checkedAt = 0;
  const read = () => {
    const now = Date.now();
    if (value === null || now - checkedAt > ttlMs) {
      value = check();
      checkedAt = now;
    }
    return value;
  };
  read.invalidate = () => {
    value = null;
  };
  return read;
}
