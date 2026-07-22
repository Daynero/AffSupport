import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { currentModelPath, whisperPath, whisperVadModelPath } from './tools.js';

export interface TranscribeOptions {
  inputPath: string;
  /** Final `.txt` path written next to the source. */
  transcriptPath: string;
  /** `auto` or an ISO 639-1 code. */
  language: string;
  onProgress: (value: number | null) => void;
}

export interface TranscribeResult {
  code: number | null;
  cancelled: boolean;
  text: string;
  detectedLanguage: string | null;
  stderr: string;
  failedStage: 'extract' | 'transcribe' | null;
  spawnErrorCode: string | null;
}

export interface TranscribeHandle {
  cancel: () => void;
  done: Promise<TranscribeResult>;
}

// Audio extraction is quick relative to inference; give it the first slice of
// the progress bar so the whisper phase reads as steady forward motion.
const EXTRACT_SHARE = 6;

/**
 * Extracts a normalized 16 kHz mono WAV with ffmpeg, then runs whisper.cpp on
 * it. Returns a handle so the queue can cancel the active child at any point.
 */
export function transcribe(options: TranscribeOptions): TranscribeHandle {
  const { inputPath, transcriptPath, language, onProgress } = options;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;

  const kill = () => {
    cancelled = true;
    activeChild?.kill('SIGTERM');
  };

  const done = (async (): Promise<TranscribeResult> => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'wishly-transcribe-'));
    const wavPath = path.join(tmpDir, 'audio.wav');
    const cleanup = () => void rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    try {
      onProgress(0);
      const extract = await runExtract(inputPath, wavPath, child => {
        activeChild = child;
      });
      if (cancelled) return result(null, true, '', null, extract.stderr, null, null);
      if (extract.spawnErrorCode) {
        return result(null, false, '', null, extract.stderr, 'extract', extract.spawnErrorCode);
      }
      if (extract.code !== 0) {
        return result(extract.code, false, '', null, extract.stderr, 'extract', null);
      }
      onProgress(EXTRACT_SHARE);

      const outputBase = transcriptPath.replace(/\.txt$/i, '');
      const run = await runWhisper(
        { wavPath, outputBase, language },
        child => {
          activeChild = child;
        },
        value =>
          onProgress(value === null ? null : EXTRACT_SHARE + (value * (100 - EXTRACT_SHARE)) / 100)
      );
      if (cancelled) return result(null, true, '', null, run.stderr, null, null);
      if (run.spawnErrorCode) {
        return result(
          null,
          false,
          '',
          run.detectedLanguage,
          run.stderr,
          'transcribe',
          run.spawnErrorCode
        );
      }
      if (run.code !== 0) {
        return result(run.code, false, '', run.detectedLanguage, run.stderr, 'transcribe', null);
      }

      const text = await readTranscript(transcriptPath);
      onProgress(100);
      return result(0, false, text, run.detectedLanguage, run.stderr, null, null);
    } finally {
      cleanup();
    }
  })();

  return { cancel: kill, done };

  function result(
    code: number | null,
    wasCancelled: boolean,
    text: string,
    detectedLanguage: string | null,
    stderr: string,
    failedStage: 'extract' | 'transcribe' | null,
    spawnErrorCode: string | null
  ): TranscribeResult {
    return {
      code,
      cancelled: wasCancelled,
      text,
      detectedLanguage,
      stderr,
      failedStage,
      spawnErrorCode
    };
  }
}

function runExtract(
  inputPath: string,
  wavPath: string,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{ code: number | null; stderr: string; spawnErrorCode: string | null }> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '-y',
    wavPath
  ];
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let spawnErrorCode: string | null = null;
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, spawnErrorCode }));
  });
}

function runWhisper(
  params: { wavPath: string; outputBase: string; language: string },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onProgress: (value: number | null) => void
): Promise<{
  code: number | null;
  stderr: string;
  detectedLanguage: string | null;
  spawnErrorCode: string | null;
}> {
  const args = buildWhisperArgs(params);
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    let stderr = '';
    let detectedLanguage: string | null =
      params.language && params.language !== 'auto' ? params.language : null;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      const value = chunk.toString();
      stderr = (stderr + value).slice(-12_000);
      const progress = /progress\s*=\s*(\d+)\s*%/.exec(value);
      if (progress) onProgress(Math.min(99, Number(progress[1])));
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(value);
      if (detected) detectedLanguage = detected[1].toLowerCase();
    };
    // whisper.cpp prints progress and the detected language on stderr, the
    // transcript on stdout — watch both.
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, detectedLanguage, spawnErrorCode }));
  });
}

export function buildWhisperArgs(
  params: { wavPath: string; outputBase: string; language: string },
  options: { threads?: number; vadModelPath?: string | null } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  const vadModelPath =
    options.vadModelPath === undefined
      ? existsSync(whisperVadModelPath)
        ? whisperVadModelPath
        : null
      : options.vadModelPath;
  const args = [
    '-m',
    currentModelPath(),
    '-f',
    params.wavPath,
    '-l',
    params.language || 'auto',
    '-otxt',
    '-of',
    params.outputBase,
    '-pp',
    // Keep timestamp tokens enabled internally for reliable long-form
    // segmentation. `-otxt` still writes plain text without timecodes, while
    // whisper.cpp's `-nt` mode can skip speech and loop on earlier phrases.
    // Accuracy: beam search + best-of temperature fallback recover far more of
    // the audio than greedy decoding, especially on noisy or accented speech.
    '-bs',
    '5',
    '-bo',
    '5',
    // Suppress non-speech tokens (harmless to real words) to trim noise symbols.
    '-sns',
    '-t',
    String(threads),
    // Gentle VAD: only skip genuine silence so the tail can't be hallucinated,
    // but keep quiet/soft speech. A low threshold + generous padding + a longer
    // required silence gap prevent VAD from clipping real sentences. Context is
    // left intact (no -mc 0) because VAD + dedup already contain repetition.
    ...(vadModelPath
      ? ['--vad', '-vm', vadModelPath, '-vt', '0.30', '-vp', '250', '-vsd', '400']
      : [])
  ];
  return args;
}

async function readTranscript(transcriptPath: string): Promise<string> {
  try {
    const raw = await readFile(transcriptPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    return collapseTranscriptArtifacts(lines).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Removes two decoder artifacts without rewriting normal speech:
 * - residual hallucination loops with the same set of words;
 * - a line cut in the middle of its final word immediately before Whisper
 *   emits the corrected, longer segment (for example `resul` / `result ...`).
 *
 * Requiring a strict continuation of the final word avoids collapsing real
 * sentences that merely begin with the same complete phrase.
 */
export function collapseTranscriptArtifacts(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (!previous) {
      out.push(line);
      continue;
    }

    const key = wordSetKey(line);
    if (key && key === wordSetKey(previous)) continue;
    if (isTruncatedPrefix(previous, line)) {
      out[out.length - 1] = line;
      continue;
    }
    if (isTruncatedPrefix(line, previous)) continue;
    out.push(line);
  }
  return out;
}

function wordSetKey(line: string): string {
  return Array.from(new Set(words(line)))
    .sort()
    .join(' ');
}

function isTruncatedPrefix(shorter: string, longer: string): boolean {
  if (/[.!?…।॥؟。！？]$/u.test(shorter.trim())) return false;
  const shortWords = words(shorter);
  const longWords = words(longer);
  if (shortWords.length < 3 || longWords.length <= shortWords.length) return false;

  const last = shortWords.length - 1;
  for (let index = 0; index < last; index += 1) {
    if (shortWords[index] !== longWords[index]) return false;
  }

  return (
    longWords[last].length > shortWords[last].length && longWords[last].startsWith(shortWords[last])
  );
}

function words(line: string): string[] {
  return (
    line
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  );
}
