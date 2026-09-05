import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { activeGovernorOrNull, activeThreadBudget, scaled, spawnTracked } from '../power/spawn.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptionQualityMode } from '@video-compressor/shared';
import { ffmpegPath, probeDuration } from '../ffmpeg/tools.js';
import { currentPlatform } from '../platform/platform.js';
import {
  currentModelPath,
  WHISPER_MODELS,
  whisperPath,
  whisperVadModelPathOrNull
} from './tools.js';
import { ProgressSmoother } from './progress-smoother.js';
import { measureSpeechExtent } from './silence-tail.js';
import { mergeChunkWords, parseWhisperFullJson, type WhisperWord } from './words.js';
import {
  attachInactivityWatchdog,
  defaultWhisperThreads,
  EXTRACT_INACTIVITY_TIMEOUT_MS,
  TEMP_DIRECTORY_PREFIX
} from './runtime.js';
// Re-exported so every existing caller — and every test — still reaches them here.
export {
  attachInactivityWatchdog,
  defaultWhisperThreads,
  sweepAbandonedTempDirectories,
  TEMP_DIRECTORY_PREFIX
} from './runtime.js';

export interface TranscribeOptions {
  inputPath: string;
  /** `auto` or an ISO 639-1 code. */
  language: string;
  /** Which model to load and how hard to decode; see the shared type for the trade-off. */
  quality?: TranscriptionQualityMode;
  /**
   * Also run Whisper's speech→English task for language families where that is
   * a more reliable translation pivot than the noisy source transcript.
   */
  createEnglishPivot?: boolean;
  onProgress: (value: number | null) => void;
  /**
   * Called the moment Whisper names the language, long before the transcript exists.
   *
   * A file started before the quick probe finished has nothing to show but its file name;
   * this is what lets the row say what is being spoken while the run is still going.
   */
  onLanguage?: (language: string) => void;
  /** Length of the source, already probed by the queue; drives the extract's share. */
  durationSeconds?: number | null;
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
   * Merged, monotonic word timestamps for the structured document. Empty when
   * whisper produced no parseable JSON — the plain-text transcript is
   * unaffected either way.
   */
  words: WhisperWord[];
  /** Speech-derived English pivot, empty when it was not requested/available. */
  englishText: string;
  /** Word timestamps for mapping the English pivot back onto source segments. */
  englishWords: WhisperWord[];
  /** The model label the run used, recorded on the document it produced. */
  modelLabel: string;
  /** Seconds of the source that were listened to (its length minus a skipped silent tail). */
  audibleSeconds: number | null;
}

/**
 * What a pause achieved. `no-child` is the gap between two stages — the next one starts held;
 * `unsupported` is a machine that cannot suspend a process at all.
 */
export type PauseOutcome = 'held' | 'released' | 'no-child' | 'unsupported';

export interface TranscribeHandle {
  cancel: () => void;
  /**
   * Suspends or resumes the running child, keeping its memory and its position.
   *
   * Reports back whether anything is actually held: between two stages there is
   * no child to stop, and a caller that pretends otherwise would show a paused
   * interface over a machine still at full load. The wish is remembered either
   * way, so the next child starts suspended.
   */
  setPaused: (paused: boolean) => PauseOutcome;
  done: Promise<TranscribeResult>;
}

// Audio extraction is quick relative to inference; give it the first slice of
// the progress bar so the whisper phase reads as steady forward motion. The
// decode of the source takes most of that slice; the loudness pass over the
// audible part is a second, much shorter, step.
const EXTRACT_SHARE = 6;
const DECODE_SHARE = 5;
/** How often the estimate advances between real reports. Four times a second reads as smooth. */
const PROGRESS_TICK_MS = 250;
// The source transcription pass covers almost the whole bar. The optional
// hi/ur English pivot is a rare, additive second pass that advances only the
// final sliver, so the bar never moves backward for the common single-pass run.
const SOURCE_END = 97;
const PIVOT_END = 99;

/**
 * Extracts a normalized 16 kHz mono WAV, then transcribes it in a single
 * whisper.cpp long-form pass with Silero VAD enabled. VAD drops silence so the
 * decoder never hallucinates a subtitle credit on a trailing silent tail, and
 * whisper's own 30 s windowing keeps context across the whole recording — no
 * external chunking, so there are no chunk-boundary seams to repair. Returns a
 * handle so the queue can cancel the active child at any point.
 */
export function transcribe(options: TranscribeOptions): TranscribeHandle {
  const { inputPath, language, onProgress } = options;
  const quality: TranscriptionQualityMode = options.quality ?? 'accurate';
  const modelLabel = WHISPER_MODELS[quality].label;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;
  let paused = false;
  let releaseHold: (() => void) | null = null;

  /*
   * The governor is the only thing allowed to suspend a managed child, so a
   * pause is a hold rather than a SIGSTOP of our own: the duty cycler would
   * otherwise wake, at its next on-window, a process the person deliberately
   * stopped — and on Windows there is no such signal to send in the first
   * place.
   */
  const applyHold = () => {
    if (!paused || releaseHold || !activeChild) return;
    releaseHold = activeGovernorOrNull()?.hold(activeChild, 'transcription:paused') ?? null;
  };
  const dropHold = () => {
    releaseHold?.();
    releaseHold = null;
  };

  const setPaused = (next: boolean): PauseOutcome => {
    paused = next;
    if (!next) {
      dropHold();
      return 'released';
    }
    applyHold();
    if (releaseHold) return 'held';
    // The wish is remembered either way: the next child starts held.
    return activeChild ? 'unsupported' : 'no-child';
  };

  const kill = () => {
    cancelled = true;
    // A stopped process is not delivered SIGTERM until it runs again, so the
    // hold goes first — otherwise "stop" during a pause would hang until the
    // person happened to resume.
    paused = false;
    dropHold();
    if (activeChild) activeGovernorOrNull()?.resumeForTermination(activeChild);
    // SIGTERM alone is enough for a healthy child; the spawn seam escalates it
    // to SIGKILL if this one has stopped listening.
    activeChild?.kill('SIGTERM');
  };

  /**
   * Adopts a freshly spawned child, killing it immediately when the cancel
   * already arrived.
   *
   * A cancel that lands between two stages has no child to signal: it only sets
   * the flag, and the flag is not read again until the stage that is about to
   * start has finished. Without this the user's stop would spawn — and then
   * wait out — a full FFmpeg extract or a whole whisper pass, which is exactly
   * the "I pressed stop and the machine stayed busy" the flag exists to
   * prevent.
   */
  const adopt = (child: ChildProcessWithoutNullStreams) => {
    // The hold belonged to the child that just finished; this one needs its own.
    dropHold();
    activeChild = child;
    // Between stages there is nothing to hold: a pause then answers "no child" (and is
    // remembered), not "unsupported" for a process that has already exited.
    child.once('exit', () => {
      if (activeChild === child) activeChild = null;
    });
    if (cancelled) child.kill('SIGTERM');
    else applyHold();
  };

  /*
   * The figure the caller sees, kept moving between the ones the work reports.
   *
   * Whisper prints its position rarely and unevenly, and the extract before it says nothing
   * at all. Left raw, that is ten seconds of zero, a jump to twenty, a few four-percent steps
   * and long silences — from which nobody can tell a run that is working from one that has
   * hung. The smoother creeps towards where the next report is expected and never past it,
   * and stops creeping when the reports do, so a real stall still looks like one.
   */
  const smoother = new ProgressSmoother({ emit: value => onProgress(value) });
  smoother.startPhase(0, EXTRACT_SHARE);
  const ticker = setInterval(() => smoother.tick(), PROGRESS_TICK_MS);
  ticker.unref();

  const done = (async (): Promise<TranscribeResult> => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
    const rawWavPath = path.join(tmpDir, 'decoded.wav');
    const wavPath = path.join(tmpDir, 'audio.wav');
    // Awaited, with retries: Windows keeps the WAV busy for a moment after ffmpeg exits,
    // and a fire-and-forget removal left the scratch directory behind for the boot sweep.
    const cleanup = () =>
      rm(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
    try {
      smoother.report(0);
      // Cancelled while the temp directory was being created: never start the
      // work at all.
      if (cancelled) return result(null, true, '', null, '', null, null);
      /*
       * Two passes over the audio, on purpose.
       *
       * The first only decodes: the source becomes plain 16 kHz mono PCM, with nothing done
       * to its levels. That is the file the silence scan reads, because the loudness
       * normaliser that whisper needs lifts a near-silent tail — the hour of dithered quiet
       * under a stitched creative's final photo — above the threshold that decides whether
       * there is a tail at all, and the biggest saving in this pipeline quietly stopped
       * happening on exactly the files it was built for.
       */
      // The extract's progress is its position over the duration; without a duration the
      // first stage sat at zero. A file whose probe failed at intake is asked once more.
      const durationSeconds =
        options.durationSeconds ?? (await probeDuration(inputPath).catch(() => null));
      const extract = await runExtract(inputPath, rawWavPath, adopt, {
        durationSeconds,
        onProgress: value => smoother.report((value * DECODE_SHARE) / 100),
        isPaused: () => paused
      });
      if (cancelled) return result(null, true, '', null, extract.stderr, null, null);
      if (extract.spawnErrorCode) {
        return result(null, false, '', null, extract.stderr, 'extract', extract.spawnErrorCode);
      }
      if (extract.code !== 0) {
        return result(extract.code, false, '', null, extract.stderr, 'extract', null);
      }
      /*
       * How much of it is worth listening to.
       *
       * A third of a second to read backwards through the decode, against the hour of
       * generated silence a stitched creative carries under its final photo. Nothing is cut
       * unless the quiet runs for half a minute at the very end of the file, so an ordinary
       * recording is handed over whole and this costs it only the scan.
       */
      const extent = await measureSpeechExtent(rawWavPath);
      if (cancelled) return result(null, true, '', null, extract.stderr, null, null);
      /*
       * The second pass is the one whisper hears: rumble filter and dynamic loudness
       * normalisation, over the audible part only. A WAV-to-WAV filter over an hour of speech
       * takes a couple of seconds; over the silent tail it takes nothing, because the tail is
       * never read.
       */
      const conditioned = await runCondition(rawWavPath, wavPath, adopt, {
        audibleSeconds: extent.trimmedSeconds > 0 ? extent.audibleSeconds : null,
        onProgress: value =>
          smoother.report(DECODE_SHARE + (value * (EXTRACT_SHARE - DECODE_SHARE)) / 100),
        isPaused: () => paused
      });
      if (cancelled) return result(null, true, '', null, conditioned.stderr, null, null);
      if (conditioned.spawnErrorCode) {
        return result(
          null,
          false,
          '',
          null,
          appendDiagnostics(extract.stderr, conditioned.stderr),
          'extract',
          conditioned.spawnErrorCode
        );
      }
      if (conditioned.code !== 0) {
        return result(
          conditioned.code,
          false,
          '',
          null,
          appendDiagnostics(extract.stderr, conditioned.stderr),
          'extract',
          null
        );
      }
      // The decode is not needed past this point, and for a long source it is the largest
      // file in the directory.
      await rm(rawWavPath, { force: true }).catch(() => {});
      // Recognition runs slower than real time on every machine this ships to; twice the
      // audio's length is a deliberately pessimistic first guess, replaced by the run's own
      // rate as soon as it reports one.
      smoother.startPhase(EXTRACT_SHARE, SOURCE_END, extent.audibleSeconds * 2);

      // Source transcription: one long-form pass over everything that has sound in it.
      const sourceBase = path.join(tmpDir, 'transcript');
      const source = await runWhisper(
        {
          wavPath,
          outputBase: sourceBase,
          language,
          quality,
          audibleSeconds: extent.audibleSeconds
        },
        adopt,
        value => {
          if (value !== null) {
            smoother.report(EXTRACT_SHARE + (value * (SOURCE_END - EXTRACT_SHARE)) / 100);
          }
        },
        () => paused,
        options.onLanguage
      );
      if (cancelled)
        return result(null, true, '', source.detectedLanguage, source.stderr, null, null);
      if (source.spawnErrorCode) {
        return result(
          null,
          false,
          '',
          source.detectedLanguage,
          source.stderr,
          'transcribe',
          source.spawnErrorCode
        );
      }
      if (source.code !== 0) {
        return result(
          source.code,
          false,
          '',
          source.detectedLanguage,
          source.stderr,
          'transcribe',
          null
        );
      }

      const detectedLanguage = requestedOrDetectedLanguage(language, source.detectedLanguage);
      const text = await readTranscript(`${sourceBase}.txt`);
      const words = mergeChunkWords([await readWords(sourceBase, 0)]);
      let diagnostics = source.stderr;

      // Optional speech→English pivot for language families whose direct text
      // translation is measurably weaker (hi/ur). Purely additive: a failed or
      // unavailable pivot pass leaves the complete source transcript intact.
      let englishText = '';
      let englishWords: WhisperWord[] = [];
      if (shouldCreateEnglishPivot(detectedLanguage, options.createEnglishPivot === true)) {
        smoother.startPhase(SOURCE_END, PIVOT_END, extent.audibleSeconds * 2);
        const englishBase = path.join(tmpDir, 'english');
        const pivot = await runWhisper(
          {
            wavPath,
            outputBase: englishBase,
            language: detectedLanguage ?? language,
            quality,
            translateToEnglish: true,
            // The same stopping point: the pivot has no more use for the tail than the
            // source pass did, and the two must cover the same audio to line up.
            audibleSeconds: extent.audibleSeconds
          },
          adopt,
          value => {
            if (value !== null) {
              smoother.report(SOURCE_END + (value * (PIVOT_END - SOURCE_END)) / 100);
            }
          },
          () => paused
        );
        diagnostics = appendDiagnostics(diagnostics, pivot.stderr);
        if (cancelled) return result(null, true, '', detectedLanguage, diagnostics, null, null);
        if (pivot.code === 0 && !pivot.spawnErrorCode) {
          englishText = await readTranscript(`${englishBase}.txt`);
          englishWords = mergeChunkWords([await readWords(englishBase, 0)]);
        }
      }

      smoother.finish(100);
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
        englishWords,
        extent.audibleSeconds
      );
    } finally {
      // The estimate must not outlive the run it was estimating.
      clearInterval(ticker);
      await cleanup();
    }
  })();

  return { cancel: kill, setPaused, done };

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
    englishWords: WhisperWord[] = [],
    audibleSeconds: number | null = null
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
      englishWords,
      modelLabel,
      audibleSeconds
    };
  }
}

interface FfmpegRunResult {
  code: number | null;
  stderr: string;
  spawnErrorCode: string | null;
}

/**
 * Decodes the source's audio to plain 16 kHz mono PCM, untouched otherwise.
 */
function runExtract(
  inputPath: string,
  wavPath: string,
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  options: {
    /** Total length of the source, so the machine-readable position becomes a percentage. */
    durationSeconds: number | null;
    onProgress: (value: number) => void;
    isPaused: () => boolean;
  }
): Promise<FfmpegRunResult> {
  return runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      // Machine-readable position on stdout. Without it the first stretch of a transcription
      // reports nothing at all — an hour-long source spends real seconds here, and a bar that
      // sits at zero is indistinguishable from one that has hung.
      '-progress',
      'pipe:1',
      '-nostats',
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
    ],
    onChild,
    options
  );
}

/**
 * Conditions the decoded audio for recognition and cuts it at the last sound.
 *
 * Rumble filter + dynamic loudness normalization: quiet or unevenly mixed speech (music
 * beds, distant mics) reaches whisper at a stable level, which measurably reduces misheard
 * words on soft passages.
 */
function runCondition(
  rawWavPath: string,
  wavPath: string,
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  options: {
    /** Where to stop, in seconds; null keeps the whole file. */
    audibleSeconds: number | null;
    onProgress: (value: number) => void;
    isPaused: () => boolean;
  }
): Promise<FfmpegRunResult> {
  return runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-progress',
      'pipe:1',
      '-nostats',
      '-i',
      rawWavPath,
      ...(options.audibleSeconds !== null && options.audibleSeconds > 0
        ? ['-t', options.audibleSeconds.toFixed(3)]
        : []),
      '-af',
      'highpass=f=80,dynaudnorm=f=250:g=15',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-y',
      wavPath
    ],
    onChild,
    {
      durationSeconds: options.audibleSeconds,
      onProgress: options.onProgress,
      isPaused: options.isPaused
    }
  );
}

function runFfmpeg(
  args: string[],
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  options: {
    durationSeconds: number | null;
    onProgress: (value: number) => void;
    /** A held child is silent on purpose; the watchdog must not read that as a stall. */
    isPaused: () => boolean;
  }
): Promise<FfmpegRunResult> {
  const { durationSeconds, onProgress, isPaused } = options;
  return new Promise(resolve => {
    const child = spawnTracked(ffmpegPath, args, {
      toolId: 'transcription'
    }) as ChildProcessWithoutNullStreams;
    onChild(child);
    // The same watchdog whisper has. A decode from a network volume that went away, or a
    // container that makes the demuxer spin, used to hold the single queue forever — and
    // "stop" could not reach it, because the stop only ever signalled a child that talks.
    const watchdog = attachInactivityWatchdog(child, isPaused, () =>
      scaled(EXTRACT_INACTIVITY_TIMEOUT_MS)
    );
    let stderr = '';
    let spawnErrorCode: string | null = null;
    child.stderr.on('data', chunk => {
      watchdog.reset();
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.stdout.on('data', chunk => {
      watchdog.reset();
      if (!durationSeconds || durationSeconds <= 0) return;
      const position = lastOutTimeSeconds(chunk.toString());
      if (position !== null) {
        onProgress(Math.min(100, (position / durationSeconds) * 100));
      }
    });
    child.once('error', error => {
      spawnErrorCode =
        'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED';
    });
    child.once('close', code => resolve({ code, stderr, spawnErrorCode }));
  });
}

/** The most recent `out_time_ms` in a `-progress` block, in seconds. */
export function lastOutTimeSeconds(chunk: string): number | null {
  let seconds: number | null = null;
  for (const line of chunk.split(/\r?\n/)) {
    const matched = /^out_time_ms=(\d+)$/u.exec(line.trim());
    // Microseconds despite the name — ffmpeg has reported it that way for years.
    if (matched) seconds = Number(matched[1]) / 1_000_000;
  }
  return seconds;
}

function runWhisper(
  params: {
    wavPath: string;
    outputBase: string;
    language: string;
    quality?: TranscriptionQualityMode;
    translateToEnglish?: boolean;
    audibleSeconds?: number | null;
  },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onProgress: (value: number | null) => void,
  /** A paused child produces nothing; the stall watchdog must not read that as a stall. */
  isPaused: () => boolean = () => false,
  /** Told the language as soon as it is printed, not at the end of the run. */
  onLanguage?: (language: string) => void
): Promise<{
  code: number | null;
  stderr: string;
  detectedLanguage: string | null;
  spawnErrorCode: string | null;
}> {
  const args = buildWhisperArgs(params);
  return new Promise(resolve => {
    const child = spawnTracked(whisperPath, args, {
      toolId: 'transcription'
    }) as ChildProcessWithoutNullStreams;
    onChild(child);
    const watchdog = attachInactivityWatchdog(child, isPaused);
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
      if (detected) {
        detectedLanguage = detected[1].toLowerCase();
        onLanguage?.(detectedLanguage);
      }
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
  params: {
    wavPath: string;
    outputBase: string;
    language: string;
    /** Which model to load and how hard to decode; defaults to the full model. */
    quality?: TranscriptionQualityMode;
    translateToEnglish?: boolean;
    /** Stop here instead of at the end of the file; see `silence-tail.ts`. */
    audibleSeconds?: number | null;
  },
  options: { threads?: number; vadModelPath?: string | null; platform?: NodeJS.Platform } = {}
): string[] {
  const quality = params.quality ?? 'accurate';
  const platform = options.platform ?? currentPlatform();
  // The shared budget wins when a limit is in force; otherwise the default above stands.
  // Deriving a value from the budget at 100% would push this to a full core count on a
  // 10-core machine — making transcription hotter by default than it was before the
  // throttle existed.
  const threads = options.threads ?? activeThreadBudget() ?? defaultWhisperThreads();
  const vadModelPath =
    options.vadModelPath === undefined ? whisperVadModelPathOrNull() : options.vadModelPath;
  const args = [
    '-m',
    currentModelPath(quality),
    '-f',
    params.wavPath,
    '-l',
    params.language || 'auto',
    // Whisper's speech→English task, used only for the hi/ur pivot pass.
    ...(params.translateToEnglish ? ['-tr'] : []),
    '-otxt',
    // Full JSON (per-token millisecond offsets + probabilities) so the
    // structured document can carry word timestamps for karaoke playback.
    '-oj',
    '-ojf',
    // Split token offsets on word boundaries for stable per-word ranges.
    '-sow',
    '-of',
    params.outputBase,
    // Print progress so the queue can drive the progress bar.
    '-pp',
    // No `-fa`: flash attention was measured on Apple Silicon (M1, large-v3, 57 s of
    // speech) at 92 s against 85 s without it, and the CPU build gains nothing from it
    // either. Requested only once a measurement says otherwise.
    // Beam search + best-of temperature fallback is what recovers speech under a music bed
    // that greedy decoding drops. On Apple Silicon the turbo model's four-layer decoder
    // makes the search close to free — measured on a noisy sample it was no slower than
    // greedy and punctuated the same as the full model — so both modes search there. On a
    // CPU-only machine five beams are five decoder passes, and the fast mode exists for
    // exactly that machine: it decodes greedily and keeps the best-of fallback, which only
    // costs anything on a window that greedy decoding has already got wrong.
    ...(quality === 'fast' && platform !== 'darwin'
      ? ['-bs', '1', '-bo', '5']
      : ['-bs', '5', '-bo', '5']),
    // Suppress non-speech tokens (harmless to real words) to trim noise symbols.
    '-sns',
    // Everything after the last sound is not listened to. A stitched creative carries its
    // final photo — and the silence under it — for half an hour or more, and that silence was
    // costing more than the whole of the speech.
    ...(params.audibleSeconds && params.audibleSeconds > 0
      ? ['-d', String(Math.ceil(params.audibleSeconds * 1000))]
      : []),
    '-t',
    String(threads),
    // Silero VAD: whisper runs only on detected speech, so the classic
    // "hallucinated subtitle credit on trailing silence" loop cannot occur. A
    // low threshold + generous padding + a longer required silence gap keep VAD
    // from clipping quiet/soft speech while still trimming genuine silence.
    // Context is left intact so long-form segmentation stays coherent.
    ...(vadModelPath
      ? ['--vad', '-vm', vadModelPath, '-vt', '0.30', '-vp', '250', '-vsd', '400']
      : [])
  ];
  return args;
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

/**
 * Reads whisper's plain-text output, sanitizes each line, collapses decoder
 * artifacts, then drops trailing subtitle-credit hallucinations.
 */
async function readTranscript(temporaryOutputPath: string): Promise<string> {
  try {
    const raw = await readFile(temporaryOutputPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map(line => stripNonSpeechArtifacts(line).trim())
      .filter(Boolean);
    const collapsed = collapseTranscriptArtifacts(lines).map(stripCreditSuffix).filter(Boolean);
    return dropTrailingCredits(collapsed).join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Reads the full-JSON word timestamps whisper wrote next to an output base and
 * shifts them by `offsetMs`. A missing/unreadable JSON simply yields no words,
 * so the text transcript keeps working on older whisper builds.
 */
async function readWords(outputBase: string, offsetMs: number): Promise<WhisperWord[]> {
  try {
    return parseWhisperFullJson(await readFile(`${outputBase}.json`, 'utf8'), offsetMs);
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
    .replace(/[♪♫♬]+/gu, ' ')
    .replace(/(?<=^|[\s"'«„“([—–-])(?:\.{2,}|…+)(?=[\s"'»”)\]—–-]|$)/gu, ' ')
    .replace(/(?:\.{3,}|…+)\s*$/u, '')
    .replace(/[^\S\r\n]{2,}/gu, ' ');
}

/**
 * Well-known Whisper "subtitle credit" hallucinations — translator credits,
 * channel subscribe/thanks-for-watching calls, and caption-site tags it learned
 * from subtitle training data. Whisper emits these on trailing music or the
 * speech→silence boundary in whatever language it decoded. Each pattern matches
 * a WHOLE trimmed line (anchored and short), so real speech that merely contains
 * a word like "thanks" is never touched. `\b` is avoided after Arabic because JS
 * word boundaries are ASCII-only.
 */
const CREDIT_LINE_PATTERNS: readonly RegExp[] = [
  // Arabic translator credits, e.g. "ترجمة نانسي قنقر", "الترجمة بواسطة ...".
  /^(?:ال)?ترجمة(?:\s.{0,40})?$/u,
  /^ترجمة\s+و?تعديل(?:\s.{0,40})?$/u,
  // Arabic channel calls-to-action on trailing music/silence.
  /^اشترك(?:وا)?\s+(?:في|بـ?)?\s*القناة(?:\s.{0,20})?$/u,
  /^(?:شكرا|شكراً)\s+(?:لكم\s+)?(?:على|لـ?)\s*المشاهدة(?:\s.{0,20})?$/u,
  /^لا\s+تنس(?:وا?|ى)\s+(?:الاشتراك|الإعجاب|الاعجاب)(?:\s.{0,30})?$/u,
  // English subtitle credits.
  /^subtitles?\s+by\s+.{0,40}$/iu,
  /^(?:transcription|translation|captions?)\s+by\s+.{0,40}$/iu,
  /^thanks?\s+for\s+watching.{0,20}$/iu,
  /^thank\s+you\s+for\s+watching.{0,20}$/iu,
  /^(?:please\s+)?(?:don'?t\s+forget\s+to\s+)?(?:like\s+(?:and|&)\s+)?subscribe.{0,30}$/iu,
  /^amara\.org.{0,40}$/iu,
  /^www\..{0,40}$/iu
];

/** True when a whole line is a known subtitle-credit hallucination. */
export function isCreditHallucination(line: string): boolean {
  const trimmed = line.trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
  if (!trimmed) return false;
  return CREDIT_LINE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Removes a credit clause tacked onto the end of an otherwise-real line, after
 * that line's final sentence punctuation (for example
 * `… فرصتكم. ترجمة نانسي قنقر`). Only triggers when the trailing clause is a
 * recognized credit, so real sentences are left untouched.
 */
export function stripCreditSuffix(line: string): string {
  const match = /^(.*[.!?…۔؟।॥。！？])\s*([^.!?…۔؟।॥。！？]+)$/u.exec(line);
  if (!match) return line;
  return isCreditHallucination(match[2]) ? match[1].trim() : line;
}

/**
 * Drops trailing subtitle-credit hallucinations. Only consecutive credit lines
 * at the very end are removed — a credit-like line earlier in the transcript is
 * assumed to be real speech and kept.
 */
export function dropTrailingCredits(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isCreditHallucination(lines[end - 1])) end -= 1;
  return end === lines.length ? lines : lines.slice(0, end);
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
