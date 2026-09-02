import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { activeGovernorOrNull, activeThreadBudget, spawnTracked } from '../power/spawn.js';
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
   * Merged, monotonic word timestamps for the structured document. Empty when
   * whisper produced no parseable JSON — the plain-text transcript is
   * unaffected either way.
   */
  words: WhisperWord[];
  /** Speech-derived English pivot, empty when it was not requested/available. */
  englishText: string;
  /** Word timestamps for mapping the English pivot back onto source segments. */
  englishWords: WhisperWord[];
}

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
  setPaused: (paused: boolean) => boolean;
  done: Promise<TranscribeResult>;
}

// Audio extraction is quick relative to inference; give it the first slice of
// the progress bar so the whisper phase reads as steady forward motion.
const EXTRACT_SHARE = 6;
// The source transcription pass covers almost the whole bar. The optional
// hi/ur English pivot is a rare, additive second pass that advances only the
// final sliver, so the bar never moves backward for the common single-pass run.
const SOURCE_END = 97;
const PIVOT_END = 99;

// A whisper child that produces no output for this long is considered stuck —
// without a watchdog it would block the single shared inference queue forever.
const WHISPER_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

/** A wall-clock budget stretched to match the resource limit in force. */
function scaled(milliseconds: number): number {
  return activeGovernorOrNull()?.scaleTimeout(milliseconds) ?? milliseconds;
}

/**
 * Inactivity watchdog: re-armed on every stdout/stderr chunk; on expiry the
 * child gets SIGTERM, escalating to SIGKILL when it ignores that too.
 */
function attachInactivityWatchdog(
  child: ChildProcessWithoutNullStreams,
  isPaused: () => boolean = () => false
): {
  reset: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // A suspended child is silent by construction. Killing it for that would
      // turn "pause" into "lose the run after ten minutes", so the window is
      // simply started again and the deadline effectively waits for the resume.
      if (isPaused()) {
        arm();
        return;
      }
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      force.unref();
      child.once('close', () => clearTimeout(force));
      // Read on every arm, not once: whisper is a managed child, so at a
      // reduced limit it is suspended for most of every duty period and the gap
      // between two progress lines stretches with it. A fixed window would end
      // a healthy transcription for obeying the user's own setting — and the
      // job would be reported as a stalled engine, blaming the wrong thing.
    }, scaled(WHISPER_INACTIVITY_TIMEOUT_MS));
    timer.unref();
  };
  arm();
  child.once('close', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  return { reset: arm };
}

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

  const setPaused = (next: boolean) => {
    paused = next;
    if (!next) {
      dropHold();
      return true;
    }
    applyHold();
    return releaseHold !== null;
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
    if (cancelled) child.kill('SIGTERM');
    else applyHold();
  };

  const done = (async (): Promise<TranscribeResult> => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'wishly-transcribe-'));
    const wavPath = path.join(tmpDir, 'audio.wav');
    const cleanup = () => void rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    try {
      onProgress(0);
      // Cancelled while the temp directory was being created: never start the
      // work at all.
      if (cancelled) return result(null, true, '', null, '', null, null);
      const extract = await runExtract(inputPath, wavPath, adopt);
      if (cancelled) return result(null, true, '', null, extract.stderr, null, null);
      if (extract.spawnErrorCode) {
        return result(null, false, '', null, extract.stderr, 'extract', extract.spawnErrorCode);
      }
      if (extract.code !== 0) {
        return result(extract.code, false, '', null, extract.stderr, 'extract', null);
      }
      onProgress(EXTRACT_SHARE);

      // Source transcription: one long-form pass over the whole file.
      const sourceBase = path.join(tmpDir, 'transcript');
      const source = await runWhisper(
        { wavPath, outputBase: sourceBase, language },
        adopt,
        value =>
          onProgress(
            value === null ? null : EXTRACT_SHARE + (value * (SOURCE_END - EXTRACT_SHARE)) / 100
          ),
        () => paused
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
        const englishBase = path.join(tmpDir, 'english');
        const pivot = await runWhisper(
          {
            wavPath,
            outputBase: englishBase,
            language: detectedLanguage ?? language,
            translateToEnglish: true
          },
          adopt,
          value =>
            onProgress(
              value === null ? null : SOURCE_END + (value * (PIVOT_END - SOURCE_END)) / 100
            ),
          () => paused
        );
        diagnostics = appendDiagnostics(diagnostics, pivot.stderr);
        if (cancelled) return result(null, true, '', detectedLanguage, diagnostics, null, null);
        if (pivot.code === 0 && !pivot.spawnErrorCode) {
          englishText = await readTranscript(`${englishBase}.txt`);
          englishWords = mergeChunkWords([await readWords(englishBase, 0)]);
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
    } finally {
      cleanup();
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
    const child = spawnTracked(ffmpegPath, args, {
      toolId: 'transcription'
    }) as ChildProcessWithoutNullStreams;
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
  params: { wavPath: string; outputBase: string; language: string; translateToEnglish?: boolean },
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onProgress: (value: number | null) => void,
  /** A paused child produces nothing; the stall watchdog must not read that as a stall. */
  isPaused: () => boolean = () => false
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
  params: {
    wavPath: string;
    outputBase: string;
    language: string;
    translateToEnglish?: boolean;
  },
  options: { threads?: number; vadModelPath?: string | null } = {}
): string[] {
  // The shared budget wins when a limit is in force; otherwise the historical
  // default stands. Deriving a value from the budget at 100% would push this
  // from 8 threads to a full core count on a 10-core machine — making
  // transcription hotter by default than it was before the throttle existed.
  const threads = options.threads ?? activeThreadBudget() ?? Math.max(4, os.cpus().length - 2);
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
