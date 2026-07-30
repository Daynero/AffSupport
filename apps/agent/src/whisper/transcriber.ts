import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { currentModelPath, whisperPath, whisperVadModelPath } from './tools.js';
import { mergeChunkWords, parseWhisperFullJson, type WhisperWord } from './words.js';

export interface TranscribeOptions {
  inputPath: string;
  /** `auto` or an ISO 639-1 code. */
  language: string;
  /**
   * Also run Whisper's speech→English task for language families where that is
   * a more reliable translation pivot than the noisy source transcript.
   */
  createEnglishPivot?: boolean;
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
  /**
   * Merged, monotonic word timestamps for the structured document. Empty on the
   * compatibility fallback path or when whisper produced no parseable JSON — the
   * plain-text transcript is unaffected either way.
   */
  words: WhisperWord[];
  /** Speech-derived English pivot, empty when it was not requested/available. */
  englishText: string;
  /** Word timestamps for mapping the English pivot back onto source segments. */
  englishWords: WhisperWord[];
}

export interface TranscribeHandle {
  cancel: () => void;
  done: Promise<TranscribeResult>;
}

// Audio extraction is quick relative to inference; give it the first slice of
// the progress bar so the whisper phase reads as steady forward motion.
const EXTRACT_SHARE = 6;
const DETECT_END = 12;
const CHUNK_PREP_END = 15;
const PRIMARY_TRANSCRIBE_END = 88;
const BRIDGE_PREP_END = 90;
const INFERENCE_END = 99;
const PIVOT_SOURCE_PRIMARY_END = 48;
const PIVOT_SOURCE_BRIDGE_PREP_END = 50;
const PIVOT_SOURCE_INFERENCE_END = 54;
const PIVOT_INFERENCE_END = 99;
const SPEECH_CHUNK_MS = 12_000;
// 3s of shared audio is enough for the text merge to find the seam, while
// halving how much speech is decoded twice (every double-decode is a chance
// for the two windows to disagree and leave a duplicated phrase behind).
const SPEECH_CHUNK_OVERLAP_MS = 3_000;
const SPEECH_CONTEXT_CHUNK_MS = 20_000;
const MERGE_SPEECH_GAP_MS = 750;
const SPEECH_EDGE_PADDING_MS = 250;

// A whisper child that produces no output for this long is considered stuck —
// without a watchdog it would block the single shared inference queue forever.
const WHISPER_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

/**
 * Inactivity watchdog: re-armed on every stdout/stderr chunk; on expiry the
 * child gets SIGTERM, escalating to SIGKILL when it ignores that too.
 */
function attachInactivityWatchdog(child: ChildProcessWithoutNullStreams): {
  reset: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      force.unref();
      child.once('close', () => clearTimeout(force));
    }, WHISPER_INACTIVITY_TIMEOUT_MS);
    timer.unref();
  };
  arm();
  child.once('close', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  return { reset: arm };
}

export interface SpeechRange {
  startMs: number;
  endMs: number;
}

export interface BridgeChunk {
  beforeIndex: number;
  range: SpeechRange;
}

/**
 * Extracts a normalized 16 kHz mono WAV, detects speech with Silero, then
 * transcribes bounded overlapping windows. Returns a handle so the queue can
 * cancel the active child at any point.
 */
export function transcribe(options: TranscribeOptions): TranscribeHandle {
  const { inputPath, language, onProgress } = options;
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

      if (existsSync(whisperVadModelPath)) {
        const detection = await runVadDetection({ wavPath }, child => {
          activeChild = child;
        });
        if (cancelled) {
          return result(null, true, '', null, detection.stderr, null, null);
        }
        if (detection.spawnErrorCode) {
          return result(
            null,
            false,
            '',
            requestedOrDetectedLanguage(language, detection.detectedLanguage),
            detection.stderr,
            'transcribe',
            detection.spawnErrorCode
          );
        }
        if (detection.code !== 0) {
          return result(
            detection.code,
            false,
            '',
            requestedOrDetectedLanguage(language, detection.detectedLanguage),
            detection.stderr,
            'transcribe',
            null
          );
        }

        const detectedLanguage = requestedOrDetectedLanguage(language, detection.detectedLanguage);
        const createEnglishPivot = shouldCreateEnglishPivot(
          detectedLanguage,
          options.createEnglishPivot === true
        );
        const sourcePrimaryEnd = createEnglishPivot
          ? PIVOT_SOURCE_PRIMARY_END
          : PRIMARY_TRANSCRIBE_END;
        const sourceBridgePrepEnd = createEnglishPivot
          ? PIVOT_SOURCE_BRIDGE_PREP_END
          : BRIDGE_PREP_END;
        const sourceInferenceEnd = createEnglishPivot ? PIVOT_SOURCE_INFERENCE_END : INFERENCE_END;
        const ranges = buildSpeechChunks(detection.speechRanges);
        onProgress(DETECT_END);
        if (ranges.length === 0) {
          onProgress(100);
          return result(0, false, '', detectedLanguage, detection.stderr, null, null);
        }

        const chunkPaths: string[] = [];
        let diagnostics = detection.stderr;
        for (let index = 0; index < ranges.length; index += 1) {
          const chunkPath = path.join(tmpDir, `speech-${String(index).padStart(4, '0')}.wav`);
          const clip = await runExtractClip(wavPath, chunkPath, ranges[index], child => {
            activeChild = child;
          });
          diagnostics = appendDiagnostics(diagnostics, clip.stderr);
          if (cancelled) {
            return result(null, true, '', detectedLanguage, diagnostics, null, null);
          }
          if (clip.spawnErrorCode) {
            return result(
              null,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'extract',
              clip.spawnErrorCode
            );
          }
          if (clip.code !== 0) {
            return result(clip.code, false, '', detectedLanguage, diagnostics, 'extract', null);
          }
          chunkPaths.push(chunkPath);
          onProgress(DETECT_END + ((index + 1) * (CHUNK_PREP_END - DETECT_END)) / ranges.length);
        }

        const chunkRun = await runChunkWhisper(
          {
            wavPaths: chunkPaths,
            language: detectedLanguage ?? language
          },
          child => {
            activeChild = child;
          },
          completed =>
            onProgress(
              CHUNK_PREP_END + (completed * (sourcePrimaryEnd - CHUNK_PREP_END)) / chunkPaths.length
            )
        );
        diagnostics = appendDiagnostics(diagnostics, chunkRun.stderr);
        if (cancelled) {
          return result(null, true, '', detectedLanguage, diagnostics, null, null);
        }
        if (chunkRun.spawnErrorCode) {
          return result(
            null,
            false,
            '',
            detectedLanguage,
            diagnostics,
            'transcribe',
            chunkRun.spawnErrorCode
          );
        }
        if (chunkRun.code !== 0) {
          return result(
            chunkRun.code,
            false,
            '',
            detectedLanguage,
            diagnostics,
            'transcribe',
            null
          );
        }

        const chunks = await Promise.all(chunkPaths.map(chunkPath => readRawTranscript(chunkPath)));
        const bridges = buildBridgeChunks(ranges, chunks);
        const bridgeTexts: string[] = [];
        const bridgePaths: string[] = [];
        if (bridges.length > 0) {
          for (let index = 0; index < bridges.length; index += 1) {
            const bridgePath = path.join(tmpDir, `bridge-${String(index).padStart(4, '0')}.wav`);
            const clip = await runExtractClip(wavPath, bridgePath, bridges[index].range, child => {
              activeChild = child;
            });
            diagnostics = appendDiagnostics(diagnostics, clip.stderr);
            if (cancelled) {
              return result(null, true, '', detectedLanguage, diagnostics, null, null);
            }
            if (clip.spawnErrorCode) {
              return result(
                null,
                false,
                '',
                detectedLanguage,
                diagnostics,
                'extract',
                clip.spawnErrorCode
              );
            }
            if (clip.code !== 0) {
              return result(clip.code, false, '', detectedLanguage, diagnostics, 'extract', null);
            }
            bridgePaths.push(bridgePath);
            onProgress(
              sourcePrimaryEnd +
                ((index + 1) * (sourceBridgePrepEnd - sourcePrimaryEnd)) / bridges.length
            );
          }

          const bridgeRun = await runChunkWhisper(
            {
              wavPaths: bridgePaths,
              language: detectedLanguage ?? language
            },
            child => {
              activeChild = child;
            },
            completed =>
              onProgress(
                sourceBridgePrepEnd +
                  (completed * (sourceInferenceEnd - sourceBridgePrepEnd)) / bridgePaths.length
              )
          );
          diagnostics = appendDiagnostics(diagnostics, bridgeRun.stderr);
          if (cancelled) {
            return result(null, true, '', detectedLanguage, diagnostics, null, null);
          }
          if (bridgeRun.spawnErrorCode) {
            return result(
              null,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'transcribe',
              bridgeRun.spawnErrorCode
            );
          }
          if (bridgeRun.code !== 0) {
            return result(
              bridgeRun.code,
              false,
              '',
              detectedLanguage,
              diagnostics,
              'transcribe',
              null
            );
          }
          bridgeTexts.push(
            ...(await Promise.all(bridgePaths.map(bridgePath => readRawTranscript(bridgePath))))
          );
        }

        const refinedChunks = interleaveBridgeTexts(chunks, bridges, bridgeTexts);
        const text = mergeTranscriptChunks(refinedChunks);

        // Collect word timestamps from the same passes (no extra inference) and
        // merge them into one monotonic sequence. Purely additive: any failure
        // here leaves `words` empty and the text transcript intact.
        const chunkWordLists = await Promise.all(
          chunkPaths.map((chunkPath, index) => readChunkWords(chunkPath, ranges[index].startMs))
        );
        const bridgeWordLists = await Promise.all(
          bridges.map((bridge, index) =>
            readChunkWords(
              path.join(tmpDir, `bridge-${String(index).padStart(4, '0')}.wav`),
              bridge.range.startMs
            )
          )
        );
        const words = mergeChunkWords([...chunkWordLists, ...bridgeWordLists]);

        let englishText = '';
        let englishWords: WhisperWord[] = [];
        if (createEnglishPivot) {
          const pivotPaths = [...chunkPaths, ...bridgePaths];
          const pivotRun = await runChunkWhisper(
            {
              wavPaths: pivotPaths,
              language: detectedLanguage ?? language,
              translateToEnglish: true
            },
            child => {
              activeChild = child;
            },
            completed =>
              onProgress(
                sourceInferenceEnd +
                  (completed * (PIVOT_INFERENCE_END - sourceInferenceEnd)) / pivotPaths.length
              )
          );
          diagnostics = appendDiagnostics(diagnostics, pivotRun.stderr);
          if (cancelled) {
            return result(null, true, '', detectedLanguage, diagnostics, null, null);
          }
          // The pivot is an additive quality path. A runtime that cannot perform
          // speech translation must not discard an otherwise complete source
          // transcript; the text translator will fall back to that transcript.
          if (pivotRun.code === 0 && !pivotRun.spawnErrorCode) {
            const pivotChunks = await Promise.all(
              chunkPaths.map(chunkPath => readRawTranscript(chunkPath))
            );
            const pivotBridgeTexts = await Promise.all(
              bridgePaths.map(bridgePath => readRawTranscript(bridgePath))
            );
            englishText = mergeTranscriptChunks(
              interleaveBridgeTexts(pivotChunks, bridges, pivotBridgeTexts)
            );
            const pivotChunkWordLists = await Promise.all(
              chunkPaths.map((chunkPath, index) => readChunkWords(chunkPath, ranges[index].startMs))
            );
            const pivotBridgeWordLists = await Promise.all(
              bridges.map((bridge, index) =>
                readChunkWords(bridgePaths[index], bridge.range.startMs)
              )
            );
            englishWords = mergeChunkWords([...pivotChunkWordLists, ...pivotBridgeWordLists]);
          }
        }

        onProgress(100);
        return result(
          0,
          false,
          text,
          detectedLanguage,
          diagnostics,
          null,
          null,
          words,
          englishText,
          englishWords
        );
      }

      // Compatibility fallback for source builds that do not have the bundled
      // Silero model. Production builds use the short-window path above.
      const outputBase = path.join(tmpDir, 'transcript');
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

      const text = await readTranscript(`${outputBase}.txt`);
      const words = await readChunkWords(outputBase, 0);
      onProgress(100);
      return result(0, false, text, run.detectedLanguage, run.stderr, null, null, words);
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
    spawnErrorCode: string | null,
    words: WhisperWord[] = [],
    englishText = '',
    englishWords: WhisperWord[] = []
  ): TranscribeResult {
    return {
      code,
      cancelled: wasCancelled,
      text,
      detectedLanguage,
      stderr,
      failedStage,
      spawnErrorCode,
      words,
      englishText,
      englishWords
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
    // Rumble filter + dynamic loudness normalization: quiet or unevenly mixed
    // speech (music beds, distant mics) reaches whisper at a stable level,
    // which measurably reduces misheard words on soft passages.
    '-af',
    'highpass=f=80,dynaudnorm=f=250:g=15',
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

function runExtractClip(
  wavPath: string,
  chunkPath: string,
  range: SpeechRange,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{ code: number | null; stderr: string; spawnErrorCode: string | null }> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-ss',
    (range.startMs / 1000).toFixed(3),
    '-t',
    ((range.endMs - range.startMs) / 1000).toFixed(3),
    '-i',
    wavPath,
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
    chunkPath
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

function runVadDetection(
  params: { wavPath: string },
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<{
  code: number | null;
  stderr: string;
  detectedLanguage: string | null;
  speechRanges: SpeechRange[];
  spawnErrorCode: string | null;
}> {
  const args = buildVadDetectionArgs(params);
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    const watchdog = attachInactivityWatchdog(child);
    let output = '';
    let stderr = '';
    let detectedLanguage: string | null = null;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      watchdog.reset();
      const value = chunk.toString();
      output += value;
      stderr = (stderr + value).slice(-12_000);
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(value);
      if (detected) detectedLanguage = detected[1].toLowerCase();
    };
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => {
      const detected = /auto-detected language:\s*([a-z]{2,3})/i.exec(output);
      resolve({
        code,
        stderr,
        detectedLanguage: detectedLanguage ?? detected?.[1]?.toLowerCase() ?? null,
        speechRanges: parseVadSpeechRanges(output),
        spawnErrorCode
      });
    });
  });
}

function runChunkWhisper(
  params: { wavPaths: string[]; language: string; translateToEnglish?: boolean },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onChunkComplete: (completed: number) => void
): Promise<{
  code: number | null;
  stderr: string;
  spawnErrorCode: string | null;
}> {
  const args = buildChunkWhisperArgs(params);
  return new Promise(resolve => {
    const child = spawn(whisperPath, args, { shell: false });
    onChild(child);
    const watchdog = attachInactivityWatchdog(child);
    let stderr = '';
    let completed = 0;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      watchdog.reset();
      const value = chunk.toString();
      stderr = (stderr + value).slice(-12_000);
      const saved = value.match(/output_txt:\s+saving output to/gi)?.length ?? 0;
      for (let index = 0; index < saved; index += 1) {
        completed += 1;
        onChunkComplete(Math.min(completed, params.wavPaths.length));
      }
    };
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
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
    const watchdog = attachInactivityWatchdog(child);
    let stderr = '';
    let detectedLanguage: string | null =
      params.language && params.language !== 'auto' ? params.language : null;
    let spawnErrorCode: string | null = null;
    const consume = (chunk: Buffer) => {
      watchdog.reset();
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
    '-oj',
    '-ojf',
    '-sow',
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

export function buildVadDetectionArgs(
  params: { wavPath: string },
  options: { threads?: number; vadModelPath?: string } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  const vadModelPath = options.vadModelPath ?? whisperVadModelPath;
  return [
    '-m',
    currentModelPath(),
    '-f',
    params.wavPath,
    '-l',
    'auto',
    '-dl',
    '-t',
    String(threads),
    '--vad',
    '-vm',
    vadModelPath,
    '-vt',
    '0.30',
    '-vp',
    '250',
    '-vsd',
    '400'
  ];
}

export function buildChunkWhisperArgs(
  params: { wavPaths: string[]; language: string; translateToEnglish?: boolean },
  options: { threads?: number } = {}
): string[] {
  const threads = options.threads ?? Math.max(4, os.cpus().length - 2);
  return [
    '-m',
    currentModelPath(),
    '-l',
    params.language || 'auto',
    ...(params.translateToEnglish ? ['-tr'] : []),
    '-otxt',
    // Additionally emit full JSON (per-token millisecond offsets) so the
    // structured document can carry word timestamps for karaoke playback. This
    // is written to `<wav>.json` and does not affect the `-otxt` transcript.
    '-oj',
    '-ojf',
    // `-nt` must never be used for the structured pass. whisper.cpp still
    // emits token offsets in full JSON with `-nt`, but most later tokens then
    // collapse onto the segment end; karaoke visibly trails the speech and
    // catches up by jumping several words. Keep timestamp decoding enabled and
    // split on word boundaries for stable per-word ranges.
    '-sow',
    // A coarse temperature ladder (0 → 0.4 → 0.8) lets whisper escape the
    // repetition/entropy failures large-v3 hits on short windows, while few
    // enough steps that a retry cannot silently swap a complete beam result
    // for a much shorter greedy one on every segment.
    '-tp',
    '0',
    '-tpi',
    '0.4',
    '-np',
    '-bs',
    '5',
    '-bo',
    '5',
    '-sns',
    '-t',
    String(threads),
    ...params.wavPaths
  ];
}

export function parseVadSpeechRanges(output: string): SpeechRange[] {
  const ranges: SpeechRange[] = [];
  const seen = new Set<string>();
  const pattern =
    /\bVAD segment\s+\d+:\s+start\s*=\s*(\d+(?:\.\d+)?),\s+end\s*=\s*(\d+(?:\.\d+)?)/gi;
  for (const match of output.matchAll(pattern)) {
    const startMs = Math.round(Number(match[1]) * 1000);
    const endMs = Math.round(Number(match[2]) * 1000);
    const key = `${startMs}:${endMs}`;
    if (endMs <= startMs || seen.has(key)) continue;
    seen.add(key);
    ranges.push({ startMs, endMs });
  }
  return ranges.sort((left, right) => left.startMs - right.startMs);
}

export function buildSpeechChunks(
  speechRanges: SpeechRange[],
  options: {
    chunkMs?: number;
    overlapMs?: number;
    mergeGapMs?: number;
    contextChunkMs?: number;
    edgePaddingMs?: number;
  } = {}
): SpeechRange[] {
  const chunkMs = options.chunkMs ?? SPEECH_CHUNK_MS;
  const overlapMs = options.overlapMs ?? SPEECH_CHUNK_OVERLAP_MS;
  const mergeGapMs = options.mergeGapMs ?? MERGE_SPEECH_GAP_MS;
  const contextChunkMs = Math.max(chunkMs, options.contextChunkMs ?? SPEECH_CONTEXT_CHUNK_MS);
  const edgePaddingMs = options.edgePaddingMs ?? SPEECH_EDGE_PADDING_MS;
  const strideMs = chunkMs - overlapMs;
  if (chunkMs <= 0 || overlapMs < 0 || strideMs <= 0) return [];

  const merged: SpeechRange[] = [];
  for (const range of speechRanges
    .filter(range => range.endMs > range.startMs)
    .map(range => ({
      startMs: Math.max(0, range.startMs - edgePaddingMs),
      endMs: range.endMs + edgePaddingMs
    }))
    .sort((left, right) => left.startMs - right.startMs)) {
    const previous = merged.at(-1);
    if (previous && range.startMs - previous.endMs <= mergeGapMs) {
      previous.endMs = Math.max(previous.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }

  const chunks: SpeechRange[] = [];
  for (const range of merged) {
    if (range.endMs - range.startMs <= chunkMs) {
      chunks.push({ ...range });
      continue;
    }

    // Give the first words extra right-hand context. The bounded windows below
    // still guarantee coverage if this longer anchor reaches the token limit.
    chunks.push({
      startMs: range.startMs,
      endMs: Math.min(range.endMs, range.startMs + contextChunkMs)
    });
    let lastStart = range.startMs;
    let cursor = range.startMs + strideMs;
    while (cursor + chunkMs < range.endMs) {
      chunks.push({ startMs: cursor, endMs: cursor + chunkMs });
      lastStart = cursor;
      cursor += strideMs;
    }

    const finalStart = Math.max(range.startMs, range.endMs - chunkMs);
    if (finalStart - lastStart < 1000) {
      chunks[chunks.length - 1].endMs = range.endMs;
    } else {
      chunks.push({ startMs: finalStart, endMs: range.endMs });
    }
  }
  return chunks;
}

export function buildBridgeChunks(
  ranges: SpeechRange[],
  transcripts: string[],
  contextMs = SPEECH_CONTEXT_CHUNK_MS
): BridgeChunk[] {
  const bridges: BridgeChunk[] = [];
  for (let index = 1; index < Math.min(ranges.length, transcripts.length); index += 1) {
    const leftRange = ranges[index - 1];
    const rightRange = ranges[index];
    const leftText = transcripts[index - 1].trim();
    const rightText = transcripts[index].trim();
    const stepMs = rightRange.startMs - leftRange.startMs;
    if (
      stepMs <= 0 ||
      rightRange.startMs >= leftRange.endMs ||
      (leftText && rightText && findTranscriptOverlap(leftText, rightText))
    ) {
      continue;
    }

    // Re-decode the union of both disagreeing windows so the model sees
    // context before and after the failed seam. Normal 12-second windows with
    // 50% overlap produce an 18-second union. If callers provide wider ranges,
    // keep the retry bounded and center it on their shared audio.
    const unionStart = leftRange.startMs;
    const unionEnd = rightRange.endMs;
    const unionDuration = unionEnd - unionStart;
    let startMs = unionStart;
    let endMs = unionEnd;
    if (unionDuration > contextMs) {
      const overlapCenter = Math.round(
        (Math.max(leftRange.startMs, rightRange.startMs) +
          Math.min(leftRange.endMs, rightRange.endMs)) /
          2
      );
      startMs = Math.max(
        unionStart,
        Math.min(unionEnd - contextMs, Math.round(overlapCenter - contextMs / 2))
      );
      endMs = startMs + contextMs;
    }
    bridges.push({
      beforeIndex: index,
      range: { startMs, endMs }
    });
  }
  return bridges;
}

function interleaveBridgeTexts(
  chunks: string[],
  bridges: BridgeChunk[],
  bridgeTexts: string[]
): string[] {
  const refined: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    for (let bridgeIndex = 0; bridgeIndex < bridges.length; bridgeIndex += 1) {
      if (bridges[bridgeIndex].beforeIndex === index) {
        refined.push(bridgeTexts[bridgeIndex] ?? '');
      }
    }
    refined.push(chunks[index]);
  }
  return refined;
}

/**
 * Hindi/Urdu ad speech is frequently colloquial, profane, and code-switched.
 * On measured samples, Whisper's native speech→English task retained that
 * meaning while TranslateGemma could not reliably recover it from the noisy
 * Devanagari transcript. Keep the extra pass targeted so languages with strong
 * direct text translation do not pay a blanket 2× Whisper cost.
 */
export function shouldCreateEnglishPivot(language: string | null, requested: boolean): boolean {
  if (!requested || !language) return false;
  const base = language.trim().replaceAll('_', '-').split('-')[0].toLowerCase();
  return base === 'hi' || base === 'ur';
}

async function readTranscript(temporaryOutputPath: string): Promise<string> {
  try {
    const raw = await readFile(temporaryOutputPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map(line => stripNonSpeechArtifacts(line).trim())
      .filter(Boolean);
    return collapseTranscriptArtifacts(lines).join('\n').trim();
  } catch {
    return '';
  }
}

async function readRawTranscript(wavPath: string): Promise<string> {
  try {
    return await readFile(`${wavPath}.txt`, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Reads the full-JSON word timestamps whisper wrote next to a chunk wav and
 * shifts them to absolute time. A missing/unreadable JSON simply yields no
 * words, so the text transcript keeps working on older whisper builds.
 */
async function readChunkWords(wavPath: string, offsetMs: number): Promise<WhisperWord[]> {
  try {
    return parseWhisperFullJson(await readFile(`${wavPath}.json`, 'utf8'), offsetMs);
  } catch {
    return [];
  }
}

/**
 * Strips decoder hallucination markers that large-v3 emits on near-silent or
 * clipped windows: bracketed annotations (`[BLANK_AUDIO]`, `[Music]`),
 * parenthesized sound descriptions (`(music)`), musical notes, and bare
 * ellipsis tokens standing in for audio the decoder gave up on. Spoken
 * language never produces these spellings, so removal is safe across scripts.
 * Ellipses attached to a word are kept except at the very end of a chunk,
 * where they mark truncation and would otherwise survive the overlap merge.
 */
export function stripNonSpeechArtifacts(text: string): string {
  return text
    .replace(/\[[^\]\n]*\]/gu, ' ')
    .replace(/\([^()\n]*\)/gu, ' ')
    .replace(/[\u266A\u266B\u266C]+/gu, ' ')
    .replace(
      /(?<=^|[\s"'\u00AB\u201E\u201C([\u2014\u2013-])(?:\.{2,}|\u2026+)(?=[\s"'\u00BB\u201D)\]\u2014\u2013-]|$)/gu,
      ' '
    )
    .replace(/(?:\.{3,}|\u2026+)\s*$/u, '')
    .replace(/[^\S\r\n]{2,}/gu, ' ');
}

export function mergeTranscriptChunks(chunks: string[]): string {
  const clean = chunks
    .map(chunk =>
      stripNonSpeechArtifacts(chunk)
        .replace(/\uFFFD+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    )
    .filter(Boolean);
  if (clean.length === 0) return '';

  let merged = clean[0];
  for (const chunk of clean.slice(1)) {
    const overlap = findTranscriptOverlap(merged, chunk);
    if (!overlap) {
      merged = `${merged}\n${chunk}`;
      continue;
    }

    // Prefer the newer window inside the shared audio. It has more context
    // after the boundary and can replace a clipped or hallucinated left tail.
    const left = merged.slice(0, overlap.leftStart).trimEnd();
    const right = chunk.slice(overlap.rightStart).trimStart();
    merged = joinTranscriptText(left, right);
  }

  const lines = merged
    .replace(/[^\S\r\n]+/gu, ' ')
    .split(/(?<=[.!?…।॥؟。！？])(?:\s+|\n+)/u)
    .flatMap(line => line.split(/\n+/u))
    .map(line => line.trim())
    .filter(Boolean);
  return collapseTranscriptArtifacts(lines).join('\n').trim();
}

interface TranscriptWord {
  normalized: string;
  start: number;
}

function findTranscriptOverlap(
  leftText: string,
  rightText: string
): { leftStart: number; rightStart: number } | null {
  const left = transcriptWords(leftText);
  const right = transcriptWords(rightText);
  const leftStart = Math.max(0, left.length - 80);
  const rightEnd = Math.min(right.length, 50);
  let best:
    | {
        score: number;
        leftStart: number;
        rightStart: number;
      }
    | undefined;

  for (let leftIndex = leftStart; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightEnd; rightIndex += 1) {
      let length = 0;
      let exact = 0;
      while (
        leftIndex + length < left.length &&
        rightIndex + length < right.length &&
        similarTranscriptWord(
          left[leftIndex + length].normalized,
          right[rightIndex + length].normalized
        )
      ) {
        if (left[leftIndex + length].normalized === right[rightIndex + length].normalized) {
          exact += 1;
        }
        length += 1;
      }
      const matchedCharacters = left
        .slice(leftIndex, leftIndex + length)
        .reduce((total, word) => total + word.normalized.length, 0);
      const leftTail = left.length - (leftIndex + length);
      const rightPrefix = rightIndex;
      const boundaryPair =
        length === 2 && exact === 2 && matchedCharacters >= 5 && leftTail <= 2 && rightPrefix <= 2;
      if ((length < 3 && !boundaryPair) || exact < 2) continue;
      if (length === 3 && matchedCharacters < 12) continue;

      if (leftTail > 35 || rightPrefix > 35) continue;
      const score = length * 100 + exact * 10 - leftTail * 2 - rightPrefix;
      if (!best || score > best.score) {
        best = {
          score,
          leftStart: left[leftIndex].start,
          rightStart: right[rightIndex].start
        };
      }
    }
  }
  return best
    ? { leftStart: best.leftStart, rightStart: best.rightStart }
    : findCharacterOverlap(leftText, rightText);
}

function findCharacterOverlap(
  leftText: string,
  rightText: string
): { leftStart: number; rightStart: number } | null {
  const left = transcriptCharacters(leftText);
  const right = transcriptCharacters(rightText);
  const leftStart = Math.max(0, left.length - 240);
  const rightEnd = Math.min(right.length, 160);
  let best:
    | {
        score: number;
        leftStart: number;
        rightStart: number;
      }
    | undefined;

  for (let leftIndex = leftStart; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightEnd; rightIndex += 1) {
      let length = 0;
      while (
        leftIndex + length < left.length &&
        rightIndex + length < right.length &&
        left[leftIndex + length].normalized === right[rightIndex + length].normalized
      ) {
        length += 1;
      }
      if (length < 8) continue;
      const leftTail = left.length - (leftIndex + length);
      if (leftTail > 100 || rightIndex > 100) continue;
      const score = length * 10 - leftTail * 2 - rightIndex;
      if (!best || score > best.score) {
        best = {
          score,
          leftStart: left[leftIndex].start,
          rightStart: right[rightIndex].start
        };
      }
    }
  }
  return best ? { leftStart: best.leftStart, rightStart: best.rightStart } : null;
}

function transcriptWords(text: string): TranscriptWord[] {
  const output: TranscriptWord[] = [];
  const pattern = /[\p{L}\p{M}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    output.push({
      normalized: match[0].normalize('NFKC').toLocaleLowerCase(),
      start: match.index
    });
  }
  return output;
}

function transcriptCharacters(text: string): TranscriptWord[] {
  const output: TranscriptWord[] = [];
  const pattern = /[\p{L}\p{M}\p{N}]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    for (const normalized of Array.from(match[0].normalize('NFKC').toLocaleLowerCase())) {
      output.push({ normalized, start: match.index });
    }
  }
  return output;
}

function similarTranscriptWord(left: string, right: string): boolean {
  if (left === right) return true;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  if (Math.min(leftPoints.length, rightPoints.length) < 5) return false;
  const maxEdits = Math.min(leftPoints.length, rightPoints.length) >= 8 ? 2 : 1;
  if (Math.abs(leftPoints.length - rightPoints.length) > maxEdits) return false;

  let previous = Array.from({ length: rightPoints.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= leftPoints.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= rightPoints.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        (leftPoints[leftIndex - 1] === rightPoints[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution
      );
    }
    previous = current;
  }
  return previous[rightPoints.length] <= maxEdits;
}

function joinTranscriptText(left: string, right: string): string {
  if (!right) return left;
  if (!left) return right;
  const compactScript =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
  if (
    compactScript.test(left) &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
      right
    )
  ) {
    return `${left}${right}`;
  }
  return /^[,.;:!?…।॥؟。！？)\]}]/u.test(right) ? `${left}${right}` : `${left} ${right}`;
}

function requestedOrDetectedLanguage(requested: string, detected: string | null): string | null {
  return requested && requested !== 'auto' ? requested : detected;
}

function appendDiagnostics(left: string, right: string): string {
  return `${left}\n${right}`.trim().slice(-12_000);
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
    // A line with no letter or digit (bare ellipses, dashes, note symbols) is
    // always a decoder artifact, never speech.
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
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
