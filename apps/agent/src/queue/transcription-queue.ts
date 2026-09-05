import { randomUUID } from 'node:crypto';
import { access, constants, readdir, rm, stat, unlink } from 'node:fs/promises';
import { currentPlatform } from '../platform/platform.js';
import path from 'node:path';
import {
  TRANSCRIPTION_LIFECYCLE,
  canTransition,
  defaultTranscriptionSettings,
  isTranscribableFileName,
  isTranscriptionQualityMode,
  isValidTargetLanguage,
  normalizeTargetLanguage,
  TRANSCRIPTION_QUALITY_MODES,
  combineModelInfo,
  type SelectionWarning,
  type SourceKind,
  type TranscriptionDocument,
  type TranscriptionEventType,
  type TranscriptionJob,
  type TranscriptionJobStatus,
  type TranscriptionModelInfo,
  type TranscriptionMediaPreview,
  type TranscriptionQualityMode,
  type TranscriptionSettings,
  type TranscriptionState,
  type TranslationDocument
} from '@video-compressor/shared';
export { isValidTargetLanguage, normalizeTargetLanguage } from '@video-compressor/shared';
import { probeDuration } from '../ffmpeg/tools.js';
import { activeGovernorOrNull } from '../power/spawn.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { selectionWarning } from './shared.js';
import { decideTransition } from './transitions.js';
import { transcribe, type TranscribeHandle } from '../whisper/transcriber.js';
import {
  probeLanguage,
  probeQuality,
  type LanguageProbeHandle,
  type LanguageProbeResult
} from '../whisper/language-probe.js';
import { ModelDownloader } from '../whisper/downloader.js';
import {
  downloadedModelPath,
  MODEL_DESCRIPTOR,
  modelPresent,
  WHISPER_MODELS
} from '../whisper/tools.js';
import {
  installTranslationRuntimeArchive,
  finalizeTranslationModelArtifact,
  ALIGNMENT_MODEL_DESCRIPTOR,
  TRANSLATION_RUNTIME_DESCRIPTOR,
  TRANSLATION_MODEL_DESCRIPTOR,
  alignmentModelDownloadPath,
  alignmentModelPresent,
  translationModelDownloadPath,
  translationModelPresent,
  translationRuntimeArchiveDownloadPath,
  translationRuntimePresent
} from '../translation/tools.js';
import {
  buildTranscriptionDocument,
  buildTextTranscriptionDocument,
  transcriptionDocumentsRoot,
  TranscriptionDocumentStore,
  TranslationCacheStore
} from '../transcription/document-store.js';
import type { PersistedTranscriptionState } from './transcription-store.js';
import { mediaMimeType } from '../transcription/media.js';
import { saveWithTranslation as exportWithTranslation } from '../transcription/export.js';
import { MediaPreviewManager, type PreviewSource } from '../transcription/media-preview.js';
import type { Translator } from '../translation/translator.js';
import type { Aligner } from '../translation/aligner.js';
import {
  TranslationCoordinator,
  type TranslationRequestOutcome
} from './translation-coordinator.js';
export {
  automaticTranslationTarget,
  translationInputForDocument,
  type TranslationRequestOutcome
} from './translation-coordinator.js';

/**
 * The one place a transcription's status changes.
 *
 * Nine sites wrote it directly and none of them agreed on what was legal from where — which
 * is how a run interrupted by a restart came to be recorded as `failed` here while the
 * compressor recorded the identical situation as `interrupted` (A12).
 *
 * A refusal leaves the job exactly as it was and answers false. The mechanism shipped
 * permissive and was switched to strict only after a full suite run reconciled the tables
 * against the edges the code actually takes; see `apps/agent/src/queue/transitions.ts`.
 */
function transitionJob(job: TranscriptionJob, next: TranscriptionJobStatus): boolean {
  if (!decideTransition(TRANSCRIPTION_LIFECYCLE, job.status, next)) return false;
  job.status = next;
  return true;
}

/**
 * How long shutdown waits for the active transcription to actually exit.
 *
 * Scaled by the resource limit, like every other wall-clock budget that covers
 * managed work: a throttled child needs proportionally longer to reach its own
 * exit path.
 */
const SHUTDOWN_GRACE_MS = 3_000;

/** Resolves when `work` settles, or when the (scaled) budget runs out. */
function settledWithin(work: Promise<unknown>, milliseconds: number): Promise<unknown> {
  const budget = activeGovernorOrNull()?.scaleTimeout(milliseconds) ?? milliseconds;
  return Promise.race([
    work.catch(() => undefined),
    new Promise(resolve => {
      const timer = setTimeout(resolve, budget);
      // A shutdown must never be held open by its own deadline.
      timer.unref();
    })
  ]);
}

/**
 * Whether a file can be listened to right now.
 *
 * Anything but a run in flight: a finished file is still on disk, and asking for its
 * language again is a fair thing to want. `analyzing` has not been probed for a duration
 * yet, and a queued or running job's language belongs to the run.
 */
function probeableStatus(status: TranscriptionJobStatus): boolean {
  return status !== 'analyzing' && status !== 'queued' && status !== 'processing';
}

/**
 * The language to hand Whisper for this run.
 *
 * An explicit request always wins. Otherwise a language already established for the file —
 * the probe's, or a person's correction — is used instead of `auto`, because it was
 * decided on thirty seconds of speech while Whisper's own detector reads whatever the
 * file happens to open with.
 */
export function languageForRun(job: TranscriptionJob): string {
  if (job.requestedLanguage && job.requestedLanguage !== 'auto') return job.requestedLanguage;
  if (job.languageSource === 'manual' || job.languageSource === 'probe') {
    return job.detectedLanguage ?? 'auto';
  }
  return 'auto';
}

/**
 * How long a run started before its own language probe finished waits for it.
 *
 * The probe takes a handful of seconds and its answer is the better one — it listens to
 * thirty seconds of speech rather than to whatever the first thirty seconds of the file
 * happen to contain. Past this the run goes ahead on automatic detection: a person who
 * pressed Transcribe is owed a running job, not a spinner.
 */
const LANGUAGE_PROBE_WAIT_MS = 20_000;

/** A cached translation nobody has opened in this long is not worth its disk. */
const TRANSLATION_CACHE_MAX_AGE_MS = 60 * 24 * 60 * 60_000;

/** How much of a transcript the list shows: enough to recognise the file, not to read it. */
const PREVIEW_CHARACTERS = 220;
/** Least time between two progress frames for the same run. */
const PROGRESS_BROADCAST_MS = 500;

/**
 * The opening of a transcript, cut at a word.
 */

/**
 * One file, whatever the letter case.
 *
 * Windows and the default macOS volume do not tell `Clip.mp4` from `clip.mp4`; a
 * case-sensitive APFS volume does. So a match that differs only in case is confirmed by
 * asking the filesystem whether the two names are one inode.
 */
async function samePath(left: string, right: string): Promise<boolean> {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  if (currentPlatform() === 'linux' || a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    const [first, second] = await Promise.all([stat(a), stat(b)]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

export function transcriptPreview(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= PREVIEW_CHARACTERS) return flat;
  const cut = flat.slice(0, PREVIEW_CHARACTERS);
  const space = cut.lastIndexOf(' ');
  return `${(space > PREVIEW_CHARACTERS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Where the raw source media lives, for the token-gated media endpoint. */
export interface TranscriptionMediaSource {
  path: string;
  mimeType: string;
  fileName: string;
}

type Notify = (event?: TranscriptionEventType) => void;
/** ffmpeg + whisper binary availability; the model is tracked separately. */
export interface TranscriptionTooling {
  ffmpeg: boolean;
  whisper: boolean;
}

/**
 * In-memory queue that mirrors the compression pipeline: files are added,
 * validated, then transcribed strictly one at a time so a single whisper
 * process ever competes for CPU/GPU. State is broadcast through `notify`.
 */
export class TranscriptionQueue {
  private active: TranscribeHandle | null = null;
  /** Which job `active` belongs to, so a pause can name the run it means. */
  private activeJobId: string | null = null;
  /** Files waiting for the few-second language guess, oldest first. */
  private probeQueue: string[] = [];
  /** The one probe allowed to run at a time, and the job it belongs to. */
  private probing: { jobId: string; handle: LanguageProbeHandle } | null = null;
  /** Non-null while `drainProbes` is walking the queue; keeps it to one walker. */
  private probeLoop: Promise<void> | null = null;
  private inFlight = false;
  /** Uploaded temp files to unlink once their job leaves the queue. */
  private importedSources = new Set<string>();
  /** One downloader per speech model; the selected quality decides which one `state` shows. */
  private speechDownloaders: Record<TranscriptionQualityMode, ModelDownloader>;
  /** On-demand download of the local translation model (TranslateGemma). */
  private translatorDownloader: ModelDownloader;
  /** Pinned llama.cpp arm64 runtime; installed beside its dylibs from a verified archive. */
  private translatorRuntimeDownloader: ModelDownloader;
  /** Commercially-compatible multilingual semantic alignment weights. */
  private alignmentDownloader: ModelDownloader;
  /** Structured sidecar documents (words + translations), kept off the SSE path. */
  private documents: TranscriptionDocumentStore;
  private translationCache: TranslationCacheStore;
  private mediaPreviews: MediaPreviewManager;
  /** Translation and alignment of finished transcripts; see its file for the split. */
  private readonly translations: TranslationCoordinator;
  /** Current user-confirmed byte accounting groups for composite downloads. */
  private translationDownloadBatchId: string | null = null;
  /**
   * Sidecar reads/writes for one job are serialized. Atomic rename prevents a
   * torn JSON file, while this lock additionally prevents two perfectly valid
   * snapshots from overwriting each other's language/generation updates.
   */
  private documentOperations = new Map<string, Promise<void>>();
  /** Ephemeral cloud-team jobs never enter the interactive or persisted list. */
  private teamJobIds = new Set<string>();
  private teamJobLanguages = new Map<string, string>();

  /** Bumped once per broadcast by the wrapper below, never at a call site. */
  private revision = 0;
  /** Identity of this agent process, stamped on every snapshot; see the shared type. */
  private instanceId: string | null = null;
  /** Wall-clock of the last progress broadcast, so the smoother's ticks are coalesced. */
  private lastProgressBroadcast = 0;
  /** Every broadcast goes through here, so no site can forget the increment. */
  private readonly notify: Notify;

  constructor(
    private tools: TranscriptionTooling,
    private notifyRaw: Notify,
    // Jobs/settings restored from the persisted transcription state (see
    // queue/transcription-store.ts), mirroring how JobQueue receives them.
    private jobs: TranscriptionJob[] = [],
    private settings: TranscriptionSettings = defaultTranscriptionSettings()
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.notify = ((event?: Parameters<Notify>[0]) => {
      // Progress frames are coalesced here, for every sender: the transcriber's smoother
      // ticks four times a second and a translation finishes several segments a second,
      // and each frame is the whole state to every listener. Two a second is already more
      // than a bar can show; the next non-progress frame carries the final value anyway.
      if (event === 'transcription:progress') {
        const now = Date.now();
        if (now - this.lastProgressBroadcast < PROGRESS_BROADCAST_MS) return;
        this.lastProgressBroadcast = now;
      }
      this.revision += 1;
      this.notifyRaw(event);
    }) as Notify;
    this.speechDownloaders = {
      fast: this.speechDownloader('fast'),
      accurate: this.speechDownloader('accurate')
    };
    this.translatorDownloader = new ModelDownloader(
      TRANSLATION_MODEL_DESCRIPTOR,
      translationModelDownloadPath,
      translationModelPresent,
      () => this.notify(),
      // When the translator model finishes installing, resume any queued
      // translation automatically — the user just waits for the animation.
      () => this.translations.translationToolingChanged(),
      finalizeTranslationModelArtifact
    );
    this.translatorRuntimeDownloader = new ModelDownloader(
      TRANSLATION_RUNTIME_DESCRIPTOR,
      translationRuntimeArchiveDownloadPath,
      translationRuntimePresent,
      () => this.notify(),
      () => this.translations.translationToolingChanged(),
      // Windows cannot replace a directory whose executable is still mapped: the servers
      // that would hold `llama-server.exe` are stopped first.
      async archivePath => {
        await this.translations.close();
        await installTranslationRuntimeArchive(archivePath);
      }
    );
    this.alignmentDownloader = new ModelDownloader(
      ALIGNMENT_MODEL_DESCRIPTOR,
      alignmentModelDownloadPath,
      alignmentModelPresent,
      () => this.notify(),
      () => this.translations.translationToolingChanged()
    );
    this.documents = new TranscriptionDocumentStore(transcriptionDocumentsRoot());
    this.translationCache = new TranslationCacheStore(
      process.env.AGENT_TRANSLATION_CACHE_PATH ??
        path.join(applicationSupportRoot(), 'TranslationCache')
    );
    this.translations = new TranslationCoordinator(
      {
        get jobs() {
          return self.jobs;
        },
        teamJobIds: this.teamJobIds,
        get settings() {
          return self.settings;
        },
        notify: event => this.notify(event),
        document: id => this.document(id),
        mutateDocument: (jobId, mutate) => this.mutateDocument(jobId, mutate),
        transcriptionWorkPending: () => this.transcriptionWorkPending(),
        resumeTranscription: () => {
          queueMicrotask(() => void this.pump());
          // A probe that gave way to a translation has nothing else to wake it.
          queueMicrotask(() => this.pumpProbes());
        }
      },
      this.translationCache
    );
    this.mediaPreviews = new MediaPreviewManager(
      process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH ??
        path.join(applicationSupportRoot(), 'TranscriptionPreviews')
    );
    // Uploaded imports live under Application Support and survive restarts;
    // re-track them so removing a restored job still deletes its import copy.
    for (const job of this.jobs) {
      if (job.sourceKind === 'uploaded') this.importedSources.add(path.resolve(job.inputPath));
    }
    // Files restored from the last session have never been listened to. Deferred to a
    // microtask so the queue is fully built first, and so the boot's own work goes ahead of
    // a guess about a file nobody has started.
    queueMicrotask(() => this.resumeLanguageProbes());
  }

  private speechDownloader(quality: TranscriptionQualityMode): ModelDownloader {
    return new ModelDownloader(
      WHISPER_MODELS[quality],
      () => downloadedModelPath(quality),
      () => modelPresent(quality),
      () => this.notify(),
      () => {
        void this.pump();
        // The first model to land is also the first that can name a language.
        this.resumeLanguageProbes();
      }
    );
  }

  /** The downloader of the model the selected quality runs on. */
  private get downloader(): ModelDownloader {
    return this.speechDownloaders[this.settings.quality];
  }

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId;
  }

  /**
   * Housekeeping for the caches this queue owns, run once at boot.
   *
   * Never awaited by the boot path: a slow disk must not delay the first request, and
   * nothing here is needed for the queue to work — it only keeps two directories from
   * growing for the life of the installation.
   */
  async sweepCaches(): Promise<{ translations: number; previews: number }> {
    const translations = await this.translationCache
      .sweep({
        currentModelVersion: this.translations.modelVersion(),
        maxAgeMs: TRANSLATION_CACHE_MAX_AGE_MS
      })
      .catch(() => 0);
    const previews = await this.mediaPreviews
      .sweepOrphans(new Set(this.jobs.map(job => job.id)))
      .catch(() => 0);
    return { translations, previews };
  }

  /** Injects the local translation engine (see createTranslator). */
  setTranslator(translator: Translator | null): void {
    this.translations.setTranslator(translator);
  }

  setAligner(aligner: Aligner | null): void {
    this.translations.setAligner(aligner);
  }

  /** See {@link TranslationCoordinator.requestTranslation}. */
  requestTranslation(
    id: string,
    language: string,
    requestId?: string
  ): Promise<TranslationRequestOutcome> {
    return this.translations.requestTranslation(id, language, requestId);
  }

  /** See {@link TranslationCoordinator.cancelTranslation}. */
  cancelTranslation(id: string): Promise<boolean> {
    return this.translations.cancelTranslation(id);
  }

  /** The structured document for a known job, or null if none is stored yet. */
  async document(id: string): Promise<TranscriptionDocument | null> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return null;
    return this.withDocumentLock(id, async () => {
      const stored = await this.documents.load(id);
      if (stored) return stored;
      // Seamlessly migrate successful transcripts created before structured
      // sidecars existed. This remains a separate on-demand response and never
      // puts the old plain text back into SSE state.
      if (job.status !== 'completed' || job.text === null) return null;
      const fallback = buildTextTranscriptionDocument(job, MODEL_DESCRIPTOR.label);
      await this.documents.save(fallback).catch(() => {});
      return fallback;
    });
  }

  /** Locates the raw source media for the token-gated, range-capable endpoint. */
  async mediaSource(id: string): Promise<TranscriptionMediaSource | null> {
    const job = this.jobs.find(item => item.id === id);
    if (!job || job.status !== 'completed') return null;
    try {
      await access(job.inputPath, constants.R_OK);
    } catch {
      return null;
    }
    return { path: job.inputPath, mimeType: mediaMimeType(job.fileName), fileName: job.fileName };
  }

  async mediaPreviewStatus(id: string): Promise<TranscriptionMediaPreview | null> {
    const source = await this.previewSource(id);
    return source ? this.mediaPreviews.status(id, source) : null;
  }

  async prepareMediaPreview(id: string): Promise<TranscriptionMediaPreview | null> {
    const source = await this.previewSource(id);
    return source ? this.mediaPreviews.prepare(id, source) : null;
  }

  cancelMediaPreview(id: string): boolean {
    if (!this.jobs.some(job => job.id === id)) return false;
    this.mediaPreviews.cancel(id);
    return true;
  }

  async playbackMediaSource(id: string): Promise<TranscriptionMediaSource | null> {
    const source = await this.previewSource(id);
    if (!source) return null;
    return this.mediaPreviews.prepared(id, source);
  }

  private async previewSource(id: string): Promise<PreviewSource | null> {
    const job = this.jobs.find(item => item.id === id);
    const source = await this.mediaSource(id);
    if (!job || !source) return null;
    return { ...source, durationSeconds: job.durationSeconds };
  }

  /** A previously computed translation for a language, if present. */
  async translation(id: string, language: string): Promise<TranslationDocument | null> {
    const document = await this.document(id);
    return document?.translations[normalizeTargetLanguage(language)] ?? null;
  }

  private async withDocumentLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.documentOperations.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.documentOperations.set(jobId, tail);
    try {
      return await current;
    } finally {
      if (this.documentOperations.get(jobId) === tail) this.documentOperations.delete(jobId);
    }
  }

  private async mutateDocument<T>(
    jobId: string,
    mutate: (document: TranscriptionDocument) => T
  ): Promise<T | null> {
    return this.withDocumentLock(jobId, async () => {
      const document = await this.documents.load(jobId);
      if (!document) return null;
      const result = mutate(document);
      await this.documents.save(document);
      return result;
    });
  }

  private transcriptionWorkPending(): boolean {
    return (
      this.inFlight || this.jobs.some(job => job.status === 'queued' || job.status === 'processing')
    );
  }

  state(): TranscriptionState {
    const translatorModel = combineModelInfo(
      TRANSLATION_MODEL_DESCRIPTOR.label,
      [this.translatorDownloader.status(), this.translatorRuntimeDownloader.status()],
      this.translationDownloadBatchId
    );
    const model = this.downloader.status();
    return {
      revision: this.revision,
      ...(this.instanceId ? { instance: this.instanceId } : {}),
      // The browser operates exclusively on opaque job ids. Keep local source,
      // and diagnostic paths inside the agent process instead of exposing them
      // through state/SSE.
      jobs: this.jobs
        .filter(job => !this.teamJobIds.has(job.id))
        .map(job => ({
          ...job,
          inputPath: '',
          text: null,
          errorDetails: null
        })),
      running: this.inFlight || this.translations.busy || this.translations.pendingCount > 0,
      tools: { ...this.tools, model: model.present },
      model,
      models: {
        fast: this.speechDownloaders.fast.status(),
        accurate: this.speechDownloaders.accurate.status()
      },
      translatorModel,
      translatorRuntime: this.translatorRuntimeDownloader.status(),
      alignmentModel: this.alignmentDownloader.status(),
      settings: { ...this.settings }
    };
  }

  /**
   * The restart-safe snapshot written to transcription-state.json. Transcripts
   * (`text`) and raw diagnostics stay out of it: the structured documents and
   * translations are already cached on disk by job id and re-attach on load.
   */
  persisted(): PersistedTranscriptionState {
    return {
      jobs: this.jobs
        .filter(job => !this.teamJobIds.has(job.id))
        .map(job => ({
          ...job,
          text: null,
          translation: job.translation ? { ...job.translation } : (job.translation ?? null)
        })),
      settings: { ...this.settings }
    };
  }

  teamJob(sourceKey: string): TranscriptionJob | null {
    const job = this.jobs.find(candidate => candidate.sourceKey === sourceKey);
    return job && this.teamJobIds.has(job.id) ? { ...job } : null;
  }

  startTranslatorModelDownload(downloadBatchId = randomUUID()): void {
    this.translationDownloadBatchId = downloadBatchId;
    void this.translatorDownloader.start(downloadBatchId);
    void this.translatorRuntimeDownloader.start(downloadBatchId);
    void this.alignmentDownloader.start(downloadBatchId);
  }

  cancelTranslatorModelDownload(): void {
    this.translatorDownloader.cancel();
    this.translatorRuntimeDownloader.cancel();
    this.alignmentDownloader.cancel();
  }

  workActive(): boolean {
    return (
      this.inFlight ||
      this.translations.busy ||
      TRANSCRIPTION_QUALITY_MODES.some(
        quality => this.speechDownloaders[quality].status().downloading
      ) ||
      this.translatorDownloader.status().downloading ||
      this.translatorRuntimeDownloader.status().downloading ||
      this.alignmentDownloader.status().downloading
    );
  }

  modelStatus(): TranscriptionModelInfo {
    return this.downloader.status();
  }

  /**
   * Installs a speech model — the selected quality's unless one is named — and, unless
   * asked for the speech model alone, the translation bundle with it.
   *
   * A single first-run confirmation installs every local model needed by the bilingual
   * transcript. Transcription itself remains usable if either translation component fails,
   * and a user who declined translation gets the speech model on its own.
   */
  startModelDownload(
    options: { quality?: TranscriptionQualityMode; speechOnly?: boolean } = {}
  ): void {
    const downloadBatchId = randomUUID();
    void this.speechDownloaders[options.quality ?? this.settings.quality].start(downloadBatchId);
    if (!options.speechOnly && !this.settings.translationDeclined) {
      this.startTranslatorModelDownload(downloadBatchId);
    }
  }

  cancelModelDownload(): void {
    for (const quality of TRANSCRIPTION_QUALITY_MODES) this.speechDownloaders[quality].cancel();
    this.cancelTranslatorModelDownload();
  }

  setToolAvailability(tools: TranscriptionTooling): void {
    const changed = this.tools.ffmpeg !== tools.ffmpeg || this.tools.whisper !== tools.whisper;
    this.tools = { ...tools };
    if (changed) {
      // Files restored from the last session have never been probed; the tools only become
      // known here, which is the first moment one could have run.
      this.resumeLanguageProbes();
      this.notify();
    }
  }

  /** Every waiting file nothing has listened to yet, offered to the probe again. */
  private resumeLanguageProbes(): void {
    for (const job of this.jobs) {
      if (job.status !== 'ready') continue;
      // A language with no source behind it was recorded before the probe existed: it is a
      // label nobody can say anything about, so it is measured like a fresh file.
      if (job.detectedLanguage && job.languageSource !== undefined) continue;
      this.scheduleLanguageProbe(job);
    }
  }

  updateSettings(patch: Partial<TranscriptionSettings>): void {
    if (typeof patch.language === 'string' && patch.language) {
      this.settings.language = patch.language;
    }
    if (isTranscriptionQualityMode(patch.quality)) {
      const changed = patch.quality !== this.settings.quality;
      this.settings.quality = patch.quality;
      // A queue waiting on the other model may be runnable now.
      if (changed) queueMicrotask(() => void this.pump());
    }
    if (typeof patch.translationDeclined === 'boolean') {
      if (patch.translationDeclined) this.settings.translationDeclined = true;
      else delete this.settings.translationDeclined;
      // Changing their mind the other way: the models can be fetched now, and any file
      // waiting on a translator is asked again once they arrive.
      if (!patch.translationDeclined) this.startTranslatorModelDownload();
    }
    let translationLanguageChanged = false;
    if (
      typeof patch.translationLanguage === 'string' &&
      isValidTargetLanguage(patch.translationLanguage)
    ) {
      const next = normalizeTargetLanguage(patch.translationLanguage);
      translationLanguageChanged = next !== this.settings.translationLanguage;
      this.settings.translationLanguage = next;
    }
    this.notify();
    if (translationLanguageChanged) this.translations.resumeAutomaticTranslations();
  }

  async add(paths: string[]): Promise<SelectionWarning[]> {
    const warnings: SelectionWarning[] = [];
    for (const inputPath of paths) {
      const warning = await this.addOne(inputPath, 'local', null);
      if (warning) warnings.push(warning);
    }
    return warnings;
  }

  async addUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(inputPath, 'uploaded', sourceKey, fileName);
    if (warning) {
      // The import copy is useless if it was rejected.
      await unlink(inputPath).catch(() => {});
      return [warning];
    }
    this.importedSources.add(path.resolve(inputPath));
    return [];
  }

  async addTeamUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string,
    language = this.settings.language
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(inputPath, 'uploaded', sourceKey, fileName, language);
    if (warning) return [warning];
    const job = this.jobs.find(candidate => candidate.sourceKey === sourceKey);
    if (!job) return [selectionWarning(fileName, 'inaccessible', 'The file could not be read.')];
    this.importedSources.add(path.resolve(inputPath));
    return [];
  }

  private async addOne(
    inputPath: string,
    sourceKind: SourceKind,
    sourceKey: string | null,
    fileNameOverride?: string,
    teamLanguage?: string
  ): Promise<SelectionWarning | null> {
    const fileName = fileNameOverride ?? path.basename(inputPath);
    if (!isTranscribableFileName(fileName)) {
      return selectionWarning(fileName, 'unsupported-format', 'This file format is not supported.');
    }
    if (sourceKind === 'local') {
      for (const job of this.jobs) {
        if (await samePath(job.inputPath, inputPath)) {
          return selectionWarning(fileName, 'duplicate', 'This file is already in the queue.');
        }
      }
    }
    try {
      await access(inputPath, constants.R_OK);
    } catch {
      return selectionWarning(fileName, 'inaccessible', 'This file could not be read.');
    }

    const job: TranscriptionJob = {
      id: randomUUID(),
      inputPath,
      fileName,
      sourceKind,
      sourceKey,
      durationSeconds: null,
      status: 'analyzing',
      progress: null,
      requestedLanguage: this.settings.language,
      detectedLanguage: null,
      text: null,
      characters: null,
      translation: null,
      error: null,
      errorDetails: null,
      batchId: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null
    };
    this.jobs.push(job);
    if (teamLanguage) {
      this.teamJobIds.add(job.id);
      this.teamJobLanguages.set(job.id, teamLanguage);
      job.requestedLanguage = teamLanguage;
    }
    this.notify();

    // Probe duration so the progress bar has a denominator; a probe failure is
    // not fatal — whisper can still run, the bar just stays indeterminate.
    const durationSeconds = await probeDuration(inputPath).catch(() => null);
    // Removed while the probe ran: there is nothing to mark ready and nobody to tell.
    if (!this.jobs.includes(job)) return null;
    job.durationSeconds = durationSeconds;
    transitionJob(job, 'ready');
    this.scheduleLanguageProbe(job);
    this.notify();
    return null;
  }

  /**
   * Puts a freshly added file in line for the quick language guess.
   *
   * Skipped when the language is not in question — a person who chose one in the settings,
   * or a Team Workspace job that arrives with its own — because the row would then show
   * one language and the run would use another.
   */
  private scheduleLanguageProbe(job: TranscriptionJob): void {
    if (!this.tools.ffmpeg || !this.tools.whisper) return;
    if (probeQuality() === null) return;
    if (job.languageSource === 'manual') return;
    if (!probeableStatus(job.status)) return;
    if ((this.teamJobLanguages.get(job.id) ?? this.settings.language) !== 'auto') return;
    if (this.probeQueue.includes(job.id) || this.probing?.jobId === job.id) return;
    job.languageProbing = true;
    this.probeQueue.push(job.id);
    this.pumpProbes();
  }

  /** Starts the walker unless one is already going; every caller may call it blindly. */
  private pumpProbes(): void {
    if (this.probeLoop) return;
    this.probeLoop = this.drainProbes().finally(() => {
      this.probeLoop = null;
    });
  }

  /**
   * Names the language of each waiting file, one at a time.
   *
   * Whisper and the translator own the machine when they are working; a guess about a file
   * nobody has started yet gives way to them and is taken up again from `pump`'s exit.
   */
  private async drainProbes(): Promise<void> {
    while (this.probeQueue.length) {
      if (this.inFlight || this.translations.busy) return;
      const jobId = this.probeQueue.shift() as string;
      const job = this.jobs.find(item => item.id === jobId);
      if (!job || !probeableStatus(job.status) || job.languageSource === 'manual') {
        if (job && job.languageProbing) {
          delete job.languageProbing;
          this.notify();
        }
        continue;
      }
      const handle = probeLanguage({
        inputPath: job.inputPath,
        // The first fragment lands in a few seconds and the rest refine it; the row shows
        // each answer as it arrives instead of waiting for the last one.
        onPartial: partial => this.applyProbeResult(jobId, partial)
      });
      this.probing = { jobId, handle };
      let result: LanguageProbeResult;
      try {
        result = await handle.done;
      } catch {
        result = { language: null, confidence: null, candidates: [], samples: 0, cancelled: true };
      } finally {
        if (this.probing?.jobId === jobId) this.probing = null;
      }
      // Requeued by `settleLanguageProbe` when a run needed the machine: leave the row
      // saying it is still listening, because it is.
      if (this.probeQueue.includes(jobId)) continue;
      const current = this.jobs.find(item => item.id === jobId);
      if (!current) continue;
      delete current.languageProbing;
      this.applyProbeResult(jobId, result);
      this.notify();
    }
  }

  /**
   * Writes what the probe has heard so far onto the job.
   *
   * Called after every fragment and once more at the end. A person who named the language
   * while the probe listened outranks it, and so does the run itself when it got there
   * first — so an answer is only ever written where nothing has claimed the field yet.
   */
  private applyProbeResult(jobId: string, result: Omit<LanguageProbeResult, 'cancelled'>): void {
    const job = this.jobs.find(item => item.id === jobId);
    if (!job || !result.language) return;
    if (job.languageSource !== undefined && job.languageSource !== 'probe') return;
    job.detectedLanguage = result.language;
    job.languageSource = 'probe';
    if (result.confidence !== null) job.languageConfidence = result.confidence;
    // A single fragment is an answer, not a distribution; the popover only has something
    // to show once the probe went looking for a second opinion.
    if (result.candidates.length > 1 || result.samples > 1) {
      job.languageCandidates = result.candidates;
      job.languageSamples = result.samples;
    }
    this.notify();
  }

  /**
   * Clears the way for a run that is about to start.
   *
   * Its own probe is worth the short wait — it is seconds from an answer the run would
   * otherwise have to make for itself. Another file's is not: it is cancelled, put back in
   * line, and picked up when the machine is free again.
   */
  private async settleLanguageProbe(jobId: string): Promise<void> {
    const current = this.probing;
    if (!current) return;
    if (current.jobId !== jobId) {
      current.handle.cancel();
      if (!this.probeQueue.includes(current.jobId)) this.probeQueue.unshift(current.jobId);
      return;
    }
    await settledWithin(current.handle.done, LANGUAGE_PROBE_WAIT_MS);
  }

  /**
   * Records a person's own answer to "what language is this?".
   *
   * It outranks every guess and is what the next run is told to listen for, so a file the
   * detector called Azerbaijani is transcribed as the Uzbek it is. `auto` hands the
   * question back to the machine and asks it again.
   */
  setJobLanguage(id: string, language: string): boolean {
    const job = this.jobs.find(item => item.id === id);
    if (!job) return false;
    this.cancelLanguageProbe(id);
    delete job.languageCandidates;
    delete job.languageSamples;
    if (language === 'auto') {
      job.detectedLanguage = null;
      delete job.languageSource;
      delete job.languageConfidence;
      // "Detect it again" has to actually detect again — including for a file that has
      // already been transcribed, which is where the question usually comes up. Without
      // this the row was left saying "language unknown" with nothing able to answer it.
      this.scheduleLanguageProbe(job);
    } else {
      job.detectedLanguage = language;
      job.languageSource = 'manual';
      delete job.languageConfidence;
      delete job.languageProbing;
    }
    this.notify();
    return true;
  }

  /** Drops a file out of the probe queue, stopping its probe when that one is running. */
  private cancelLanguageProbe(id: string): void {
    this.probeQueue = this.probeQueue.filter(jobId => jobId !== id);
    if (this.probing?.jobId === id) {
      this.probing.handle.cancel();
      this.probing = null;
    }
    const job = this.jobs.find(item => item.id === id);
    if (job) delete job.languageProbing;
  }

  /**
   * Queues files to run.
   *
   * A quality named here applies to these files only and does not touch the setting: it is
   * how "try this one again with the full model" works without changing what the next drop
   * of files will get.
   */
  async start(ids: string[], quality?: TranscriptionQualityMode): Promise<boolean> {
    // Asked of the table rather than listed here. The list this replaces named four states
    // and, the moment `interrupted` existed, was wrong by one: a run cut short by a restart
    // could not be started again, and the retry button reported a refusal with no way past.
    // `queued` is the question because that is where starting takes a job.
    const startable = this.jobs.filter(
      job => ids.includes(job.id) && canTransition(TRANSCRIPTION_LIFECYCLE, job.status, 'queued')
    );
    if (!startable.length) return false;
    const batchId = randomUUID();
    for (const job of startable) {
      // A re-run cancels any translation still in flight: it belongs to text
      // that is about to be replaced.
      //
      // The stored document is deliberately NOT deleted here. Doing so made
      // "Transcribe again" destructive the moment it was pressed — a run that
      // then failed, was cancelled, or died with the agent left the user with
      // no transcript at all. The sidecar is written atomically on completion,
      // so the previous one simply stays readable until a new one replaces it,
      // and nothing shows it in the meantime because the job is no longer
      // `completed`.
      if (job.status === 'completed') this.translations.cancelTranslationsForJob(job.id);
      transitionJob(job, 'queued');
      job.batchId = batchId;
      job.progress = null;
      job.error = null;
      job.errorDetails = null;
      job.text = null;
      job.characters = null;
      delete job.preview;
      job.translation = null;
      // What is known about the language survives a re-run: a probe listened to this exact
      // audio, and a person's correction is the whole point of having one. Only the
      // previous run's own guess is dropped, so the new run may reach a different one.
      if (job.languageSource === 'run') {
        job.detectedLanguage = null;
        delete job.languageSource;
        delete job.languageConfidence;
        delete job.languageCandidates;
        delete job.languageSamples;
      }
      job.finishedAt = null;
      delete job.paused;
      delete job.audibleSeconds;
      job.quality = quality ?? this.settings.quality;
      job.requestedLanguage = this.teamJobLanguages.get(job.id) ?? this.settings.language;
    }
    this.translations.preemptTranslationForTranscription();
    this.notify();
    void this.pump();
    return true;
  }

  cancel(id: string): boolean {
    const cancelled = this.cancelJob(id);
    if (cancelled) this.notify();
    return cancelled;
  }

  /**
   * Suspends or resumes the running transcription.
   *
   * Whisper has no pause of its own, so the child is held by the power governor
   * — it keeps its memory and its position and simply stops being scheduled.
   * Only the running job can be paused: a queued one is not costing anything
   * yet, and the caller that wants it to stay queued simply does not start it.
   */
  setPaused(id: string, paused: boolean): 'ok' | 'not-found' | 'unsupported' | 'retry' {
    const job = this.jobs.find(item => item.id === id);
    if (!job || job.status !== 'processing') return 'not-found';
    if (this.activeJobId !== id || !this.active) return 'not-found';
    // Resuming always succeeds: it releases a hold, and having none is the
    // state the caller asked for. Only a pause can find nothing to hold —
    // between two stages there is no child yet.
    const outcome = this.active.setPaused(paused);
    if (outcome === 'unsupported') return 'unsupported';
    // Between two stages there is no child yet; the hold is remembered and applies to the
    // next one, but the caller should not show a held interface over a stage that is
    // still starting — it can ask again in a moment.
    if (outcome === 'no-child') return 'retry';
    if (paused) job.paused = true;
    else delete job.paused;
    this.notify();
    return 'ok';
  }

  /**
   * Cancels one job without broadcasting; the caller decides when to notify.
   *
   * Everything the job owns stops, not just whisper. A job also drives a proxy
   * transcode for the player and a local translation pass, and both are heavy
   * enough to hold the machine at full load on their own — a stop that left
   * either running is a stop the user cannot see the effect of.
   */
  private cancelJob(id: string): boolean {
    const job = this.jobs.find(item => item.id === id);
    if (!job) return false;
    if (job.status === 'queued') {
      transitionJob(job, 'cancelled');
      this.stopJobSideWork(id);
      queueMicrotask(() => void this.translations.pumpTranslations());
      return true;
    }
    if (job.status === 'processing') {
      transitionJob(job, 'cancelled');
      delete job.paused;
      this.active?.cancel();
      this.stopJobSideWork(id);
      return true;
    }
    return false;
  }

  /** The non-whisper work a single job owns: its language probe, proxy transcode, translation. */
  private stopJobSideWork(id: string): void {
    this.cancelLanguageProbe(id);
    this.mediaPreviews.cancel(id);
    this.translations.cancelTranslationsForJob(id);
  }

  /**
   * Stops everything the user can see in one action. Queued jobs go first so
   * the pump cannot start another one while the active job is torn down, and
   * team jobs are skipped: they are invisible here, so a "stop all" in the
   * transcription tool must not kill Team Workspace work.
   */
  cancelAll(): number {
    const stoppable = (status: TranscriptionJobStatus) =>
      this.jobs
        .filter(job => job.status === status && !this.teamJobIds.has(job.id))
        .map(job => job.id);
    const ids = [...stoppable('queued'), ...stoppable('processing')];
    let stopped = 0;
    // One broadcast at the end: cancelling a long queue job by job would push a
    // full state frame per file down every open SSE connection.
    for (const id of ids) if (this.cancelJob(id)) stopped += 1;
    // "Stop everything" has to mean the tool goes quiet, and transcription is
    // only half of what this tool runs. A translation belongs to a job that has
    // already finished transcribing, so it is never in `ids` — yet it holds the
    // machine exactly as hard as whisper does, and leaving it running is what
    // makes a stopped queue still read as busy.
    stopped += this.translations.cancelVisibleTranslations();
    if (stopped) this.notify();
    return stopped;
  }

  async remove(id: string): Promise<boolean> {
    const job = this.jobs.find(item => item.id === id);
    if (!job) return false;
    if (job.status === 'processing') return false;
    this.cancelLanguageProbe(id);
    this.translations.forgetJob(id);
    this.jobs = this.jobs.filter(item => item.id !== id);
    this.teamJobIds.delete(id);
    this.teamJobLanguages.delete(id);
    await this.cleanupSource(job);
    this.notify();
    queueMicrotask(() => void this.translations.pumpTranslations());
    return true;
  }

  async removeMany(ids: string[]): Promise<void> {
    const removable = this.jobs.filter(job => ids.includes(job.id) && job.status !== 'processing');
    if (!removable.length) return;
    const removableIds = new Set(removable.map(job => job.id));
    for (const id of removableIds) {
      this.cancelLanguageProbe(id);
      this.translations.forgetJob(id);
    }
    this.jobs = this.jobs.filter(job => !removableIds.has(job.id));
    for (const id of removableIds) {
      this.teamJobIds.delete(id);
      this.teamJobLanguages.delete(id);
    }
    for (const job of removable) await this.cleanupSource(job);
    this.notify();
    queueMicrotask(() => void this.translations.pumpTranslations());
  }

  async clearCompleted(): Promise<void> {
    const cleared = this.jobs.filter(
      job => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    );
    if (!cleared.length) return;
    const clearedIds = new Set(cleared.map(job => job.id));
    for (const id of clearedIds) {
      this.cancelLanguageProbe(id);
      this.translations.forgetJob(id);
    }
    this.jobs = this.jobs.filter(job => !clearedIds.has(job.id));
    for (const id of clearedIds) {
      this.teamJobIds.delete(id);
      this.teamJobLanguages.delete(id);
    }
    for (const job of cleared) await this.cleanupSource(job);
    this.notify();
  }

  async retry(id: string, quality?: TranscriptionQualityMode): Promise<boolean> {
    const job = this.jobs.find(item => item.id === id);
    // Same question, same table. A retry is a start that the interface labels differently.
    if (!job || !canTransition(TRANSCRIPTION_LIFECYCLE, job.status, 'queued')) return false;
    // The run again, as it was: a failure retried after the setting changed used to come
    // back in the other mode without anyone choosing that.
    return this.start([id], quality ?? job.quality ?? undefined);
  }

  sourcePath(id: string): string | null {
    return this.jobs.find(job => job.id === id)?.inputPath ?? null;
  }

  /**
   * Packages a completed creative with its transcript + translation into a
   * "<language label> <char count>" folder beside the source file, moving the
   * creative inside. The job is re-pointed at the moved media so reveal and
   * playback keep working. Only local files have a meaningful "next to the
   * creative" location — uploaded temp imports are rejected.
   */
  async saveWithTranslation(
    id: string,
    languageLabel: string,
    transcriptFileName: string
  ): Promise<
    | { outcome: 'saved'; folderPath: string }
    | { outcome: 'not-found' }
    | { outcome: 'not-local' }
    | { outcome: 'no-translation' }
    | { outcome: 'failed' }
  > {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== 'completed' || !job.inputPath) return { outcome: 'not-found' };
    if (job.sourceKind !== 'local') return { outcome: 'not-local' };
    const lang = job.translation?.status === 'completed' ? job.translation.targetLanguage : null;
    if (!lang) return { outcome: 'no-translation' };
    const document = await this.document(id);
    const translation = document?.translations[lang];
    if (!document || !translation || translation.status !== 'completed') {
      return { outcome: 'no-translation' };
    }

    const translatedById = new Map(
      translation.segments.map(segment => [segment.sourceSegmentId, segment.translatedText])
    );
    const transcriptText = document.segments.map(segment => segment.sourceText).join('\n');
    const translationText = document.segments
      .map(segment => translatedById.get(segment.id) ?? '')
      .filter(Boolean)
      .join('\n');

    try {
      const result = await exportWithTranslation({
        sourcePath: job.inputPath,
        languageLabel,
        transcriptText,
        translationText,
        transcriptFileName
      });
      job.inputPath = result.movedMediaPath;
      this.notify();
      return { outcome: 'saved', folderPath: result.folderPath };
    } catch {
      return { outcome: 'failed' };
    }
  }

  async shutdown(): Promise<void> {
    this.cancelModelDownload();
    const active = this.active;
    active?.cancel();
    this.active = null;
    this.activeJobId = null;
    this.translations.abortActive();
    // Wait for whisper to actually be gone before the agent exits. Nothing
    // reaps a child of a process that has already left: an update handoff that
    // did not wait would strand a full-speed inference the replacement agent
    // has no handle on and no way to find, and the user would be left with a
    // hot machine and an app that reports itself idle. Bounded, because a
    // shutdown that hangs is its own failure — the spawn seam's SIGKILL
    // escalation is what makes the wait terminate.
    if (active) await settledWithin(active.done, SHUTDOWN_GRACE_MS);
    await this.translations.close();
    await this.mediaPreviews.close();
  }

  private async pump(): Promise<void> {
    // Whisper and translation share one local resource and never run together.
    if (this.inFlight || this.translations.busy) return;
    if (!this.tools.ffmpeg || !this.tools.whisper) return;
    const job = this.jobs.find(item => item.status === 'queued');
    if (!job) return;
    // The model the job was queued with; a job restored from before the setting existed
    // takes whatever is selected now.
    const quality = job.quality ?? this.settings.quality;
    const model = this.speechDownloaders[quality].status();
    if (!model.present) {
      // Still arriving: its completion pumps again. Gone for good — deleted from disk, or
      // its download cancelled — and the job would sit "queued" for the life of the process,
      // holding the translation pump with it. It fails with a reason the row can act on.
      if (model.downloading) return;
      // A refusal here would be a job neither running nor failing: no second pump, or the
      // two would chase each other through the microtask queue forever.
      if (!transitionJob(job, 'failed')) return;
      job.progress = null;
      job.error = 'The speech model for this run is not installed.';
      job.errorDetails = 'MODEL_MISSING';
      job.finishedAt = Date.now();
      this.notify();
      queueMicrotask(() => void this.pump());
      queueMicrotask(() => void this.translations.pumpTranslations());
      return;
    }

    this.inFlight = true;
    // A file the person started before its guess landed still gets it, and any other
    // file's probe steps aside for this run.
    await this.settleLanguageProbe(job.id);
    transitionJob(job, 'processing');
    job.quality = quality;
    job.startedAt = Date.now();
    job.progress = null;
    this.notify();

    try {
      const handle = transcribe({
        inputPath: job.inputPath,
        // A language already established — probed from thirty seconds of speech, or named
        // by the person — is what the run listens for. Whisper's own detection reads
        // whatever the file opens with, which for a creative is as often music as speech.
        language: languageForRun(job),
        quality,
        createEnglishPivot: true,
        // Already probed when the file was added; it turns the extract's own position into a
        // share, so the first seconds of a run report something instead of nothing.
        durationSeconds: job.durationSeconds ?? null,
        onProgress: value => {
          if (job.status !== 'processing') return;
          job.progress = value;
          // Coalesced in `notify`; the completed frame follows as a state event.
          this.notify('transcription:progress');
        },
        // Named minutes before the transcript exists, so a row that started with nothing
        // but a file name says what is being spoken while the run is still going.
        onLanguage: detected => {
          if (job.status !== 'processing') return;
          if (job.languageSource === 'manual' || job.detectedLanguage === detected) return;
          job.detectedLanguage = detected;
          job.languageSource = 'run';
          delete job.languageConfidence;
          // The run heard the whole file; the probe's four fragments no longer describe it.
          delete job.languageCandidates;
          delete job.languageSamples;
          this.notify();
        }
      });
      this.active = handle;
      this.activeJobId = job.id;
      const result = await handle.done;
      this.active = null;
      this.activeJobId = null;
      delete job.paused;

      // A cancel during the await flips job.status to 'cancelled'; TS still sees
      // the pre-await 'processing' literal, so widen before comparing. Don't
      // resurrect a cancelled job into completed/failed.
      const cancelledMidRun = (job.status as string) === 'cancelled';
      if (cancelledMidRun || result.cancelled) {
        transitionJob(job, 'cancelled');
        job.progress = null;
        job.finishedAt = Date.now();
      } else if (result.code === 0) {
        job.text = result.text;
        job.characters = result.text.length;
        job.preview = transcriptPreview(result.text);
        job.timed = result.words.some(word => word.endMs > word.startMs);
        if (result.audibleSeconds !== null) job.audibleSeconds = result.audibleSeconds;
        // A person's correction is not overwritten by the run it drove.
        if (job.languageSource !== 'manual' && result.detectedLanguage) {
          job.detectedLanguage = result.detectedLanguage;
          if (job.languageSource !== 'probe') job.languageSource = 'run';
        }
        job.finishedAt = Date.now();
        // The structured document (segments + word timestamps) is what the reader,
        // the export and the translation all read; the job is complete only once it
        // is on disk.
        const saved = await this.withDocumentLock(job.id, () =>
          this.documents.save(
            buildTranscriptionDocument(
              job,
              result.modelLabel,
              result.words,
              result.englishText,
              result.englishWords
            )
          )
        ).then(
          () => null,
          async (error: unknown) => {
            // On a re-run the stored document is the PREVIOUS transcript, and handing
            // it to the reader beside the new job state would be worse than handing
            // back nothing — so drop it rather than let the two disagree. And the job
            // is a failure with a reason: a "completed" job with no document used to
            // be silently dropped from the list at the next restart, which read as
            // the file never having been transcribed at all.
            await this.withDocumentLock(job.id, () => this.documents.remove(job.id)).catch(
              () => {}
            );
            return error instanceof Error ? error.message : String(error);
          }
        );
        if (saved !== null) {
          // `transitionJob` refuses for a job cancelled during the save; a refused job keeps
          // its own fields rather than being labelled with a failure it did not have.
          if (transitionJob(job, 'failed')) {
            job.progress = null;
            job.error = 'The transcript could not be saved to disk.';
            job.errorDetails = `DOCUMENT_WRITE_FAILED: ${saved}`;
          }
          return;
        }
        transitionJob(job, 'completed');
        job.progress = 100;
        // The sidecar is the transcript from here on; the copy in memory only served the
        // save, and kept for every finished file it was megabytes nothing read.
        job.text = null;
        /*
         * Queue the preferred local translation without delaying the next Whisper job.
         * Inference remains blocked until the transcription queue is empty and is served
         * instantly when already cached.
         *
         * Never for a team job. Nothing on that path reads it: the bridge takes the source
         * text, uploads it, and then removes the job — which cancels the translation it just
         * asked for. What that bought was a Gemma run competing with the upload and the next
         * file's transfer for a machine that is already the bottleneck, and then thrown away.
         */
        if (!this.teamJobIds.has(job.id)) {
          void this.translations.requestAutomaticTranslation(job.id).catch(() => {});
        }
      } else if (transitionJob(job, 'failed')) {
        job.progress = null;
        job.error =
          result.failedStage === 'extract'
            ? 'The audio track could not be prepared.'
            : 'The transcription engine failed.';
        job.errorDetails = result.stderr.slice(-4_000) || result.spawnErrorCode;
        job.finishedAt = Date.now();
      }
    } catch (error) {
      this.active = null;
      this.activeJobId = null;
      if (transitionJob(job, 'failed')) {
        job.progress = null;
        job.error = 'The transcription could not be completed.';
        job.errorDetails = error instanceof Error ? error.message : String(error);
        job.finishedAt = Date.now();
      }
    } finally {
      this.inFlight = false;
      this.notify();
      // Drain every queued Whisper job before allowing background translation.
      queueMicrotask(() => void this.pump());
      queueMicrotask(() => void this.translations.pumpTranslations());
      // Files added while this one ran, and probes that stepped aside for it.
      queueMicrotask(() => this.pumpProbes());
    }
  }

  private async cleanupSource(job: TranscriptionJob): Promise<void> {
    // Drop the structured sidecar whenever a job leaves the queue.
    await this.withDocumentLock(job.id, () => this.documents.remove(job.id));
    await this.mediaPreviews.remove(job.id);
    if (job.sourceKind !== 'uploaded') return;
    const resolved = path.resolve(job.inputPath);
    if (!this.importedSources.has(resolved)) return;
    // Keep the import alive if another queued job still points at it.
    if (this.jobs.some(item => path.resolve(item.inputPath) === resolved)) return;
    this.importedSources.delete(resolved);
    await unlink(resolved).catch(() => {});
    // The upload landed in a directory of its own; an empty one left behind per removed
    // upload is how an imports folder fills with nothing.
    await rm(path.dirname(resolved), { recursive: false }).catch(() => {});
  }

  /**
   * Removes upload directories no job points at any more.
   *
   * An upload directory outlives its job when the agent is killed between the removal and
   * the unlink, or when an older build removed the file and not the folder. Run at boot,
   * beside the other sweeps; a directory a queued job still uses is never touched.
   */
  async sweepImports(importRoot: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(importRoot);
    } catch {
      return 0;
    }
    const inUse = new Set(
      this.jobs
        .filter(job => job.sourceKind === 'uploaded')
        .map(job => path.dirname(path.resolve(job.inputPath)))
    );
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith('import-')) continue;
      const directory = path.join(importRoot, entry);
      if (inUse.has(path.resolve(directory))) continue;
      const gone = await rm(directory, { recursive: true, force: true }).then(
        () => true,
        () => false
      );
      if (gone) removed += 1;
    }
    return removed;
  }
}
