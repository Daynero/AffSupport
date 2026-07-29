import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultTranscriptionSettings,
  isValidTargetLanguage,
  normalizeTargetLanguage,
  type TranscriptionJob,
  type TranscriptionSettings,
  type TranscriptionTranslationSummary
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import {
  transcriptionDocumentFile,
  transcriptionDocumentsRoot
} from '../transcription/document-store.js';

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
  file = defaultTranscriptionStatePath()
): Promise<PersistedTranscriptionState> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const settings = migrateSettings(data.settings);
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
    return { jobs: [], settings: defaultTranscriptionSettings() };
  }
}

export async function saveTranscriptionState(
  state: PersistedTranscriptionState,
  file = defaultTranscriptionStatePath()
) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function migrateSettings(value: unknown): TranscriptionSettings {
  const defaults = defaultTranscriptionSettings();
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    language: typeof raw.language === 'string' && raw.language ? raw.language : defaults.language,
    translationLanguage: isValidTargetLanguage(raw.translationLanguage)
      ? normalizeTargetLanguage(raw.translationLanguage)
      : defaults.translationLanguage
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
  const status: TranscriptionJob['status'] = interrupted
    ? 'failed'
    : legacyStatus === 'completed' || legacyStatus === 'failed' || legacyStatus === 'cancelled'
      ? legacyStatus
      : 'ready';
  const numberOrNull = (input: unknown) => {
    if (input === null || input === undefined || input === '') return null;
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  return {
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
}

/**
 * Only a finished translation summary survives a restart. Queued/processing
 * work died with the process, and its results live in the shared translation
 * cache anyway — re-requesting the language after the restart is served from
 * there without re-running inference.
 */
function migrateTranslationSummary(value: unknown): TranscriptionTranslationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.status !== 'completed' ||
    typeof raw.targetLanguage !== 'string' ||
    !isValidTargetLanguage(raw.targetLanguage)
  ) {
    return null;
  }
  const total = Math.max(0, Number(raw.totalSegments) || 0);
  return {
    targetLanguage: normalizeTargetLanguage(raw.targetLanguage),
    status: 'completed',
    progress: 100,
    completedSegments: total,
    totalSegments: total,
    error: null
  };
}
