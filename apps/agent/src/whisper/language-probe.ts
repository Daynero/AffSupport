import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  confusableLanguages,
  type TranscriptionLanguageCandidate,
  type TranscriptionQualityMode
} from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { activeThreadBudget, scaled, spawnTracked } from '../power/spawn.js';
import { currentModelPath, modelPresent, whisperPath } from './tools.js';
import {
  attachInactivityWatchdog,
  defaultWhisperThreads,
  TEMP_DIRECTORY_PREFIX
} from './runtime.js';

/**
 * Whisper's language head reads one thirty-second window, so that is the unit the probe
 * samples in — anything shorter is padded by the encoder anyway.
 */
const WINDOW_SECONDS = 30;
/**
 * How many windows the probe is willing to listen to.
 *
 * Each one costs a full encoder pass — measured at 4.6 s on an M1 with the turbo model —
 * and only files whose language is in doubt ever get past the first. Four is enough for a
 * share a person can read ("three of four fragments") without turning a drop of twenty
 * files into minutes of background inference.
 */
const MAX_WINDOWS = 4;
/** A fragment shorter than this is too little speech to name a language from. */
const MIN_WINDOW_SECONDS = 8;
/** Above this the first window's own answer is taken as settled; see `worthMoreWindows`. */
const SETTLED_CONFIDENCE = 0.85;
/** Shares the transcriber's prefix so the boot sweep collects an abandoned probe too. */
const PROBE_DIRECTORY_PREFIX = `${TEMP_DIRECTORY_PREFIX}lang-`;
/** A probe that has said nothing for this long is not going to; the file is released. */
const PROBE_TIMEOUT_MS = 90_000;
/** 16 kHz, mono, 16-bit: one second of the probe's audio, used to size the windows. */
const BYTES_PER_SECOND = 16_000 * 2;

export interface LanguageProbeResult {
  /** ISO 639-1 code that carried the most confidence, or null when nothing was decided. */
  language: string | null;
  /** How sure that answer is, 0–1: its own confidence, averaged over the fragments. */
  confidence: number | null;
  /** Every language the detector named, most confident first. */
  candidates: TranscriptionLanguageCandidate[];
  /** How many fragments were listened to. */
  samples: number;
  /** True when the probe was stopped before it finished. */
  cancelled: boolean;
}

export interface LanguageProbeHandle {
  cancel: () => void;
  done: Promise<LanguageProbeResult>;
}

/**
 * The model the probe should load.
 *
 * The turbo build shares the full model's encoder — and the language head reads the
 * encoder — so it names the same language for a fifth of the load time. The full model is
 * used only when it is the one that happens to be installed.
 */
export function probeQuality(
  present: (quality: TranscriptionQualityMode) => boolean = modelPresent
): TranscriptionQualityMode | null {
  if (present('fast')) return 'fast';
  if (present('accurate')) return 'accurate';
  return null;
}

/**
 * Names the language spoken in a file, in a few seconds, without transcribing it.
 *
 * FFmpeg decodes the source until it has a couple of minutes of audio that is not silence
 * — `-t` counts filtered output, so on a stitched creative carrying half an hour of quiet
 * under its final photo the decode stops after the speech instead of reading to the end —
 * and cuts that into thirty-second fragments. One Whisper process then runs its language
 * head over them in turn, printing an answer per fragment.
 *
 * The first answer is handed back through `onPartial` the moment it lands (four to five
 * seconds), because that is what the row shows. The rest are only listened to when the
 * first answer is in doubt, and they are what turns "Azerbaijani" into "Azerbaijani in
 * three fragments of four, Persian in the fourth" — the honest shape of a detector that
 * cannot separate a whole family of languages.
 */
export function probeLanguage(options: {
  inputPath: string;
  /** Which model to load; defaults to the cheapest one installed. */
  quality?: TranscriptionQualityMode;
  threads?: number;
  /** Called with the running answer after every fragment, first one included. */
  onPartial?: (result: Omit<LanguageProbeResult, 'cancelled'>) => void;
}): LanguageProbeHandle {
  const quality = options.quality ?? probeQuality();
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;

  const adopt = (child: ChildProcessWithoutNullStreams) => {
    activeChild = child;
    child.once('exit', () => {
      if (activeChild === child) activeChild = null;
    });
    if (cancelled) child.kill('SIGTERM');
  };
  const cancel = () => {
    cancelled = true;
    activeChild?.kill('SIGTERM');
  };
  const nothing = (wasCancelled: boolean): LanguageProbeResult => ({
    language: null,
    confidence: null,
    candidates: [],
    samples: 0,
    cancelled: wasCancelled
  });

  const done = (async (): Promise<LanguageProbeResult> => {
    if (!quality) return nothing(false);
    const directory = await mkdtemp(path.join(os.tmpdir(), PROBE_DIRECTORY_PREFIX));
    try {
      if (cancelled) return nothing(true);
      const extracted = await runProbeExtract(options.inputPath, directory, adopt);
      if (cancelled) return nothing(true);
      if (extracted !== 0) return nothing(false);
      const windows = await probeWindows(directory);
      if (!windows.length) return nothing(false);
      const threads = options.threads ?? activeThreadBudget() ?? defaultWhisperThreads();
      const readings = await runDetect(windows, quality, threads, adopt, reading => {
        options.onPartial?.(summarize(reading));
      });
      if (cancelled && !readings.length) return nothing(true);
      return { ...summarize(readings), cancelled };
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(
        () => {}
      );
    }
  })();

  return { cancel, done };
}

/** One fragment's verdict: the language Whisper named and how sure it was. */
export interface LanguageReading {
  language: string;
  confidence: number | null;
}

/**
 * Turns per-fragment verdicts into the shares the interface shows.
 *
 * A language's share is the confidence it won with, averaged over every fragment listened
 * to. Deliberately not normalised to add up to a hundred: whisper.cpp prints only the
 * winner of each window, so the rest of that window's probability went to languages it
 * never named — and dividing that away turned "Croatian, and the model was about seven
 * tenths sure each time" into a flat hundred per cent beside a marker saying the answer was
 * in doubt.
 *
 * A fragment whose line carried no probability counts as a plain vote of one, which is all
 * that can be said about it.
 */
export function summarize(
  readings: readonly LanguageReading[]
): Omit<LanguageProbeResult, 'cancelled'> {
  if (!readings.length) return { language: null, confidence: null, candidates: [], samples: 0 };
  const weights = new Map<string, number>();
  for (const reading of readings) {
    const weight = reading.confidence ?? 1;
    weights.set(reading.language, (weights.get(reading.language) ?? 0) + weight);
  }
  const candidates = [...weights.entries()]
    .map(([language, weight]) => ({ language, share: weight / readings.length }))
    // Ties keep a stable order so a redraw never reshuffles the list under the pointer.
    .sort((left, right) => right.share - left.share || left.language.localeCompare(right.language));
  return {
    language: candidates[0].language,
    confidence: candidates[0].share,
    candidates,
    samples: readings.length
  };
}

/**
 * Whether the fragments after the first are worth their encoder passes.
 *
 * They are exactly when the answer is open to doubt: a language whose whole family the
 * detector mixes up, or one it named without much confidence. For the clean English
 * recording that is most files, the probe stops after one fragment and costs what it
 * always did.
 */
export function worthMoreWindows(reading: LanguageReading): boolean {
  if (confusableLanguages(reading.language).length > 0) return true;
  return (reading.confidence ?? 0) < SETTLED_CONFIDENCE;
}

/**
 * Up to two minutes of audible speech, conditioned the way the real run conditions it,
 * cut into thirty-second fragments.
 *
 * `silenceremove` drops every silent stretch as it goes rather than only a trailing one,
 * so a recording that opens with ten seconds of room tone still hands the detector a full
 * fragment of voice; the rumble filter and loudness normaliser are the transcription's
 * own, so the probe hears what the run will hear. The segment muxer writes the fragments
 * in the same pass, so sampling four points of the speech costs one decode.
 */
function runProbeExtract(
  inputPath: string,
  directory: string,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawnTracked(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-af',
        'silenceremove=stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB,highpass=f=80,dynaudnorm=f=250:g=15',
        '-t',
        String(WINDOW_SECONDS * MAX_WINDOWS),
        '-c:a',
        'pcm_s16le',
        '-f',
        'segment',
        '-segment_time',
        String(WINDOW_SECONDS),
        '-reset_timestamps',
        '1',
        '-y',
        path.join(directory, 'window-%03d.wav')
      ],
      { toolId: 'transcription' }
    ) as ChildProcessWithoutNullStreams;
    onChild(child);
    const watchdog = attachInactivityWatchdog(
      child,
      () => false,
      () => scaled(PROBE_TIMEOUT_MS)
    );
    child.stderr.on('data', () => watchdog.reset());
    child.stdout.on('data', () => watchdog.reset());
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
}

/** The fragments the extract produced, in order, minus any final scrap of speech. */
async function probeWindows(directory: string): Promise<string[]> {
  const entries = (await readdir(directory))
    .filter(entry => entry.startsWith('window-') && entry.endsWith('.wav'))
    .sort();
  const kept: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry);
    const { size } = await stat(full);
    // The last segment is whatever speech was left over; a second and a half of it would
    // only add a coin toss to the shares.
    if (kept.length && size < MIN_WINDOW_SECONDS * BYTES_PER_SECOND) continue;
    kept.push(full);
  }
  return kept.slice(0, MAX_WINDOWS);
}

/**
 * Runs Whisper's language head over the fragments in one process.
 *
 * `-dl` exits before decoding, and whisper.cpp prints its verdict for each file as it
 * reaches it — so the answers stream, and the child is stopped as soon as they stop being
 * worth their cost. One process means one model load for all four.
 */
function runDetect(
  windows: readonly string[],
  quality: TranscriptionQualityMode,
  threads: number,
  onChild: (child: ChildProcessWithoutNullStreams) => void,
  onReading: (readings: LanguageReading[]) => void
): Promise<LanguageReading[]> {
  return new Promise(resolve => {
    const child = spawnTracked(
      whisperPath,
      ['-m', currentModelPath(quality), '-l', 'auto', '-dl', '-t', String(threads), ...windows],
      { toolId: 'transcription' }
    ) as ChildProcessWithoutNullStreams;
    onChild(child);
    const watchdog = attachInactivityWatchdog(
      child,
      () => false,
      () => scaled(PROBE_TIMEOUT_MS)
    );
    const readings: LanguageReading[] = [];
    let pending = '';
    const consume = (chunk: Buffer) => {
      watchdog.reset();
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseDetectedLanguage(line);
        if (!parsed.language) continue;
        readings.push({ language: parsed.language, confidence: parsed.confidence });
        onReading([...readings]);
        // Settled after the first fragment, or out of fragments: nothing left to hear.
        if (
          (readings.length === 1 && !worthMoreWindows(readings[0])) ||
          readings.length >= windows.length
        ) {
          child.kill('SIGTERM');
        }
      }
    };
    child.stderr.on('data', consume);
    child.stdout.on('data', consume);
    child.once('error', () => resolve(readings));
    child.once('close', () => resolve(readings));
  });
}

/**
 * Reads whisper.cpp's detection line: `auto-detected language: uz (p = 0.512300)`.
 *
 * The probability is what the interface uses to say how sure the guess is; a line without
 * one still names a language, so it is kept and only the confidence goes missing.
 */
export function parseDetectedLanguage(output: string): {
  language: string | null;
  confidence: number | null;
} {
  const matched = /auto-detected language:\s*([a-z]{2,3})(?:\s*\(p\s*=\s*([0-9.]+)\))?/i.exec(
    output
  );
  if (!matched) return { language: null, confidence: null };
  const confidence = matched[2] === undefined ? null : Number(matched[2]);
  return {
    language: matched[1].toLowerCase(),
    confidence: Number.isFinite(confidence) ? confidence : null
  };
}
