import { randomUUID } from 'node:crypto';
import { stat, chmod, access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { replaceFile } from '../files/replace-file.js';
import path from 'node:path';
import {
  TRANSCRIPTION_LIFECYCLE,
  defaultTranscriptionSettings,
  isTranscriptionQualityMode,
  isValidTargetLanguage,
  normalizeTargetLanguage,
  type TranscriptionJob,
  type TranscriptionLanguageCandidate,
  type TranscriptionQualityMode,
  type TranscriptionSettings,
  type TranscriptionTranslationSummary
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { decideTransition } from './transitions.js';
import {
  transcriptionDocumentFile,
  transcriptionDocumentsRoot
} from '../transcription/document-store.js';
import { currentPlatform } from '../platform/platform.js';

/** Owner-only: this file names the user's own work; see queue/store.ts. */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIRECTORY = 0o700;

/**
 * Removes group and other access, and changes nothing else.
 *
 * Deliberately not `chmod(0o700)`: setting the mode outright would *restore*
 * owner permissions somebody had removed on purpose — a read-only state
 * directory is a legitimate thing for an administrator, or a test, to arrange,
 * and quietly making it writable again would defeat both. Only the bits that
 * leak to other accounts are cleared.
 */
async function tightenDirectory(directory: string): Promise<void> {
  if (currentPlatform() === 'win32') return;
  try {
    const current = (await stat(directory)).mode & 0o777;
    if ((current & 0o077) === 0) return;
    await chmod(directory, current & ~0o077);
  } catch {
    // Best effort: a directory we cannot inspect is one we cannot tighten, and
    // failing the save over it would trade a privacy nicety for lost work.
  }
}

/**
 * The transcription queue list persisted across agent restarts, mirroring the
 * compressor's `PersistedState` (queue/store.ts). Only what is needed to
 * rebuild the visible list is stored: the full transcripts and translations
 * already live in the on-disk document sidecars keyed by job id, so `text` is
 * deliberately never written here.
 */
export interface PersistedTranscriptionState {
  jobs: TranscriptionJob[];
  settings: TranscriptionSettings;
}

/** Machine-readable marker for a job whose transcription an agent restart cut short. */
export const TRANSCRIPTION_INTERRUPTED_CODE = 'INTERRUPTED';
/** Human-facing message, phrased like the compressor's interrupted-job message. */
export const TRANSCRIPTION_INTERRUPTED_MESSAGE =
  'The transcription was interrupted when the agent stopped.';

export function defaultTranscriptionStatePath() {
  return (
    process.env.AGENT_TRANSCRIPTION_STATE_PATH ??
    path.join(applicationSupportRoot(), 'transcription-state.json')
  );
}

/**
 * Loads the persisted transcription queue, tolerating a missing or corrupt
 * file. Jobs are revalidated against the filesystem the same way the
 * compressor's `loadState` does: a completed job survives only while its
 * transcript document sidecar exists (its source may legitimately be gone —
 * playback then degrades gracefully); every other job needs a readable source.
 */
export async function loadTranscriptionState(
  file = defaultTranscriptionStatePath(),
  options: {
    /**
     * The quality a state file written before the setting existed should get. The caller
     * knows which models are installed; this module does not look.
     */
    fallbackQuality?: TranscriptionQualityMode;
  } = {}
): Promise<PersistedTranscriptionState> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const settings = migrateSettings(data.settings, options.fallbackQuality);
    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const documentsRoot = transcriptionDocumentsRoot();
    const jobs = (
      await Promise.all(
        rawJobs.map(async value => {
          const job = migrateJob(value, settings);
          if (!job) return null;
          const pathToCheck =
            job.status === 'completed'
              ? transcriptionDocumentFile(documentsRoot, job.id)
              : job.inputPath;
          try {
            await access(pathToCheck);
            return job;
          } catch {
            return null;
          }
        })
      )
    ).filter((job): job is TranscriptionJob => Boolean(job));
    return { jobs, settings };
  } catch {
    return {
      jobs: [],
      settings: {
        ...defaultTranscriptionSettings(),
        ...(options.fallbackQuality ? { quality: options.fallbackQuality } : {})
      }
    };
  }
}

export async function saveTranscriptionState(
  state: PersistedTranscriptionState,
  file = defaultTranscriptionStatePath()
) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
  await tightenDirectory(directory);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Compact on purpose: the list is rewritten on every status change, and the indentation
    // of a two-hundred-file queue is a third of the bytes for nobody's benefit.
    await writeFile(temporary, JSON.stringify(state), {
      encoding: 'utf8',
      mode: OWNER_ONLY_FILE
    });
    await replaceFile(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function migrateSettings(
  value: unknown,
  fallbackQuality: TranscriptionQualityMode = defaultTranscriptionSettings().quality
): TranscriptionSettings {
  const defaults = defaultTranscriptionSettings();
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    language: typeof raw.language === 'string' && raw.language ? raw.language : defaults.language,
    translationLanguage: isValidTargetLanguage(raw.translationLanguage)
      ? normalizeTargetLanguage(raw.translationLanguage)
      : defaults.translationLanguage,
    quality: isTranscriptionQualityMode(raw.quality) ? raw.quality : fallbackQuality,
    ...(raw.translationDeclined === true ? { translationDeclined: true } : {})
  };
}

function migrateJob(value: unknown, settings: TranscriptionSettings): TranscriptionJob | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.inputPath !== 'string' ||
    typeof raw.fileName !== 'string'
  ) {
    return null;
  }
  const legacyStatus = typeof raw.status === 'string' ? raw.status : 'ready';
  // 'processing' was cut short by the restart: surface it as a failed job with
  // a dedicated code so the web's existing failed+retry UI handles it.
  // 'queued' and 'analyzing' deliberately come back as 'ready': the pump also
  // runs on model-download completion and after translations drain, so a
  // restored 'queued' job would silently auto-start (and, until it ran, block
  // pumpTranslations via transcriptionWorkPending). 'ready' keeps the file in
  // the list and hands the start decision back to the user, matching how the
  // compressor store migrates 'queued' to 'ready'.
  const interrupted = legacyStatus === 'processing';
  // `interrupted`, not `failed`. The compressor has always distinguished the two and
  // transcription did not (A12), so the same event — the agent stopping mid-run — told the
  // user their work had broken in one tool and had been interrupted in the other. Nothing
  // rewrites records already on disk: a job persisted as `failed` stays `failed`, and only
  // a run that was still `processing` when the agent stopped gets the new state.
  const status: TranscriptionJob['status'] = interrupted
    ? 'processing'
    : legacyStatus === 'completed' || legacyStatus === 'failed' || legacyStatus === 'cancelled'
      ? legacyStatus
      : 'ready';
  const numberOrNull = (input: unknown) => {
    if (input === null || input === undefined || input === '') return null;
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  const restored: TranscriptionJob = {
    id: raw.id,
    inputPath: raw.inputPath,
    fileName: raw.fileName,
    sourceKind: raw.sourceKind === 'uploaded' ? 'uploaded' : 'local',
    sourceKey: typeof raw.sourceKey === 'string' ? raw.sourceKey : null,
    durationSeconds: numberOrNull(raw.durationSeconds),
    status,
    progress: status === 'completed' ? 100 : null,
    requestedLanguage:
      typeof raw.requestedLanguage === 'string' && raw.requestedLanguage
        ? raw.requestedLanguage
        : settings.language,
    detectedLanguage: typeof raw.detectedLanguage === 'string' ? raw.detectedLanguage : null,
    // What was known about the language survives the restart. A person's correction most of
    // all: without it a file put back on the right language would come back on the wrong
    // one, and the next run would listen for the wrong one too.
    ...restoredLanguageKnowledge(raw),
    ...(isTranscriptionQualityMode(raw.quality) ? { quality: raw.quality } : {}),
    ...(status === 'completed' && typeof raw.timed === 'boolean' ? { timed: raw.timed } : {}),
    ...(status === 'completed' &&
    Number.isFinite(Number(raw.audibleSeconds)) &&
    Number(raw.audibleSeconds) > 0
      ? { audibleSeconds: Number(raw.audibleSeconds) }
      : {}),
    ...(status === 'completed' && typeof raw.preview === 'string' && raw.preview
      ? { preview: raw.preview.slice(0, 400) }
      : {}),
    // Transcript text lives in the document sidecar and is re-attached by job
    // id on demand; the persisted state never duplicates it.
    text: null,
    characters: numberOrNull(raw.characters),
    translation: status === 'completed' ? migrateTranslationSummary(raw.translation) : null,
    error: interrupted
      ? TRANSCRIPTION_INTERRUPTED_MESSAGE
      : typeof raw.error === 'string'
        ? raw.error
        : null,
    errorDetails: interrupted
      ? TRANSCRIPTION_INTERRUPTED_CODE
      : typeof raw.errorDetails === 'string'
        ? raw.errorDetails
        : null,
    batchId: null,
    createdAt: Number(raw.createdAt) || Date.now(),
    startedAt: numberOrNull(raw.startedAt),
    finishedAt: interrupted ? Date.now() : numberOrNull(raw.finishedAt)
  };

  // Restored as `processing` and then moved, rather than reconstructed as `interrupted`.
  // The run really did go from one to the other — the restart is just where it happened —
  // and routing it through the same decision as every other transition is what keeps the
  // state the interface most needs to explain inside the declaration that governs the rest.
  if (interrupted && !decideTransition(TRANSCRIPTION_LIFECYCLE, 'processing', 'interrupted')) {
    return restored;
  }
  if (interrupted) restored.status = 'interrupted';
  return restored;
}

/**
 * What a restart keeps of the probe's findings.
 *
 * Only alongside a language: a source or a share with nothing to describe would be a claim
 * about a file whose language is unknown. `languageProbing` is deliberately not restored —
 * no probe is running at boot, and the queue schedules a fresh one where it is still needed.
 */
function restoredLanguageKnowledge(raw: Record<string, unknown>): Partial<TranscriptionJob> {
  if (typeof raw.detectedLanguage !== 'string' || !raw.detectedLanguage) return {};
  const source =
    raw.languageSource === 'probe' ||
    raw.languageSource === 'run' ||
    raw.languageSource === 'manual'
      ? raw.languageSource
      : null;
  const confidence = Number(raw.languageConfidence);
  const candidates = Array.isArray(raw.languageCandidates)
    ? raw.languageCandidates
        .filter(
          (entry): entry is TranscriptionLanguageCandidate =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as TranscriptionLanguageCandidate).language === 'string' &&
            Number.isFinite((entry as TranscriptionLanguageCandidate).share)
        )
        .map(entry => ({ language: entry.language, share: entry.share }))
    : [];
  const samples = Number(raw.languageSamples);
  return {
    ...(source ? { languageSource: source } : {}),
    ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? { languageConfidence: confidence }
      : {}),
    ...(candidates.length ? { languageCandidates: candidates } : {}),
    ...(Number.isFinite(samples) && samples > 0 ? { languageSamples: samples } : {})
  };
}

/**
 * What a restart keeps of a translation.
 *
 * A finished one comes back as it was. One that was queued or running when the process
 * stopped comes back as `queued`, with no progress claimed: the work itself died with the
 * process, but the segments it had already produced are on disk in the sidecar, and the
 * queue re-requests the language on boot and resumes from them. It used to be dropped
 * altogether, which left a half-translated file showing no translation at all until the
 * user happened to pick the language again.
 */
function migrateTranslationSummary(value: unknown): TranscriptionTranslationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.targetLanguage !== 'string' || !isValidTargetLanguage(raw.targetLanguage)) {
    return null;
  }
  const targetLanguage = normalizeTargetLanguage(raw.targetLanguage);
  const total = Math.max(0, Number(raw.totalSegments) || 0);
  if (raw.status === 'completed') {
    return {
      targetLanguage,
      status: 'completed',
      progress: 100,
      completedSegments: total,
      totalSegments: total,
      error: null
    };
  }
  if (raw.status === 'queued' || raw.status === 'processing') {
    return {
      targetLanguage,
      status: 'queued',
      progress: null,
      completedSegments: 0,
      totalSegments: total,
      error: null
    };
  }
  // A file waiting for a translator that is not installed keeps saying so — and keeps the
  // way to install it — across a restart; it is re-requested the moment the models land.
  if (raw.status === 'unavailable') {
    return {
      targetLanguage,
      status: 'unavailable',
      progress: null,
      completedSegments: 0,
      totalSegments: 0,
      error: 'TRANSLATOR_UNAVAILABLE'
    };
  }
  return null;
}
