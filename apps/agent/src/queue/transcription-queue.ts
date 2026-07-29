import { randomUUID } from 'node:crypto';
import { access, constants, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultTranscriptionSettings,
  isTranscribableFileName,
  isValidTargetLanguage,
  normalizeTargetLanguage,
  translationCacheKey,
  type SelectionWarning,
  type SourceKind,
  type TranscriptionDocument,
  type TranscriptionEventType,
  type TranscriptionJob,
  type TranscriptionModelInfo,
  type TranscriptionMediaPreview,
  type TranscriptionSettings,
  type TranscriptionState,
  type TranscriptionTranslationSummary,
  type TranslationDocument
} from '@video-compressor/shared';
export { isValidTargetLanguage, normalizeTargetLanguage } from '@video-compressor/shared';
import { probeDuration } from '../ffmpeg/tools.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { selectionWarning } from './shared.js';
import { transcribe, type TranscribeHandle } from '../whisper/transcriber.js';
import { ModelDownloader } from '../whisper/downloader.js';
import { downloadedModelPath, MODEL_DESCRIPTOR, modelPresent } from '../whisper/tools.js';
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
  sourceContentHash,
  TranscriptionDocumentStore,
  TranslationCacheStore
} from '../transcription/document-store.js';
import { mediaMimeType } from '../transcription/media.js';
import { MediaPreviewManager, type PreviewSource } from '../transcription/media-preview.js';
import type { TranslationOutputSegment, Translator } from '../translation/translator.js';
import type { Aligner } from '../translation/aligner.js';

/** A pending translation request; `generation` guards against stale results. */
interface TranslationTask {
  jobId: string;
  language: string;
  generation: number;
  requestId?: string;
}

/** Where the raw source media lives, for the token-gated media endpoint. */
export interface TranscriptionMediaSource {
  path: string;
  mimeType: string;
  fileName: string;
}

/** Result of asking the queue to (re)translate a document into a language. */
export type TranslationRequestOutcome =
  | { outcome: 'completed'; translation: TranslationDocument }
  | { outcome: 'queued'; translation: TranslationDocument }
  | { outcome: 'no-document' }
  | { outcome: 'invalid-language' }
  | { outcome: 'unavailable' };

/**
 * Resolves the per-file automatic target from the preferred UI language.
 * Translating into the detected source language is avoided by falling back to
 * the other built-in Wishly language.
 */
export function automaticTranslationTarget(
  sourceLanguage: string,
  preferredLanguage: string
): string | null {
  const source = sourceLanguage.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase();
  if (!source || source === 'auto' || !isValidTargetLanguage(preferredLanguage)) return null;
  const preferred = normalizeTargetLanguage(preferredLanguage);
  if (preferred.split('-')[0]?.toLowerCase() !== source) return preferred;
  const fallback = source === 'en' ? 'uk' : 'en';
  return isValidTargetLanguage(fallback) ? normalizeTargetLanguage(fallback) : null;
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
  private jobs: TranscriptionJob[] = [];
  private settings: TranscriptionSettings = defaultTranscriptionSettings();
  private active: TranscribeHandle | null = null;
  private inFlight = false;
  /** Uploaded temp files to unlink once their job leaves the queue. */
  private importedSources = new Set<string>();
  private downloader: ModelDownloader;
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
  /** Local translation engine; null until one is wired (then reports availability). */
  private translator: Translator | null = null;
  private aligner: Aligner | null = null;
  /** True while a translation inference is running (mutually exclusive with whisper). */
  private translating = false;
  private translationTasks: TranslationTask[] = [];
  /** Latest requested generation per `${jobId}|${language}` for stale-result guarding. */
  private translationGenerations = new Map<string, number>();
  private activeTranslation: {
    key: string;
    generation: number;
    controller: AbortController;
    preemptedByTranscription: boolean;
  } | null = null;
  /** Last wall-clock a translation-progress counter was flushed to the sidecar. */
  private lastProgressWrite = 0;
  /** Current user-confirmed byte accounting groups for composite downloads. */
  private translationDownloadBatchId: string | null = null;
  /**
   * Sidecar reads/writes for one job are serialized. Atomic rename prevents a
   * torn JSON file, while this lock additionally prevents two perfectly valid
   * snapshots from overwriting each other's language/generation updates.
   */
  private documentOperations = new Map<string, Promise<void>>();
  /** Serializes target choices for one job so rapid UI changes preserve order. */
  private translationRequestOperations = new Map<string, Promise<void>>();

  constructor(
    private tools: TranscriptionTooling,
    private notify: Notify
  ) {
    this.downloader = new ModelDownloader(
      MODEL_DESCRIPTOR,
      downloadedModelPath,
      modelPresent,
      () => this.notify(),
      () => void this.pump()
    );
    this.translatorDownloader = new ModelDownloader(
      TRANSLATION_MODEL_DESCRIPTOR,
      translationModelDownloadPath,
      translationModelPresent,
      () => this.notify(),
      // When the translator model finishes installing, resume any queued
      // translation automatically — the user just waits for the animation.
      () => this.translationToolingChanged(),
      finalizeTranslationModelArtifact
    );
    this.translatorRuntimeDownloader = new ModelDownloader(
      TRANSLATION_RUNTIME_DESCRIPTOR,
      translationRuntimeArchiveDownloadPath,
      translationRuntimePresent,
      () => this.notify(),
      () => this.translationToolingChanged(),
      installTranslationRuntimeArchive
    );
    this.alignmentDownloader = new ModelDownloader(
      ALIGNMENT_MODEL_DESCRIPTOR,
      alignmentModelDownloadPath,
      alignmentModelPresent,
      () => this.notify(),
      () => this.translationToolingChanged()
    );
    this.documents = new TranscriptionDocumentStore(
      process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH ??
        path.join(applicationSupportRoot(), 'TranscriptionDocuments')
    );
    this.translationCache = new TranslationCacheStore(
      process.env.AGENT_TRANSLATION_CACHE_PATH ??
        path.join(applicationSupportRoot(), 'TranslationCache')
    );
    this.mediaPreviews = new MediaPreviewManager(
      process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH ??
        path.join(applicationSupportRoot(), 'TranscriptionPreviews')
    );
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

  /** Injects the local translation engine (see createTranslator). */
  setTranslator(translator: Translator | null): void {
    this.translator = translator;
    this.translationToolingChanged();
  }

  setAligner(aligner: Aligner | null): void {
    this.aligner = aligner;
  }

  private translationKey(jobId: string, language: string): string {
    return `${jobId}|${language}`;
  }

  private translationModelVersion(): string | undefined {
    return this.translator?.modelVersion();
  }

  private translationToolingChanged(): void {
    for (const job of this.jobs) {
      const summary = job.translation;
      if (job.status === 'completed' && summary?.status === 'unavailable') {
        void this.requestTranslation(job.id, summary.targetLanguage);
      }
    }
    void this.pumpTranslations();
  }

  private setTranslationSummary(
    jobId: string,
    translation: TranslationDocument
  ): TranscriptionTranslationSummary | null {
    const job = this.jobs.find(candidate => candidate.id === jobId);
    if (!job) return null;
    const total = Math.max(0, translation.totalSegments ?? translation.segments.length);
    const completed =
      translation.status === 'completed'
        ? total
        : Math.min(total, Math.max(0, translation.completedSegments ?? 0));
    const progress =
      translation.status === 'completed'
        ? 100
        : translation.status === 'processing' && total > 0
          ? Math.min(99, Math.round((completed / total) * 100))
          : null;
    const summary: TranscriptionTranslationSummary = {
      targetLanguage: translation.targetLanguage,
      status: translation.status,
      progress,
      completedSegments: completed,
      totalSegments: total,
      error: translation.status === 'failed' ? 'TRANSLATION_FAILED' : null
    };
    job.translation = summary;
    return summary;
  }

  private setTranslationUnavailable(jobId: string, targetLanguage: string): void {
    const job = this.jobs.find(candidate => candidate.id === jobId);
    if (!job) return;
    job.translation = {
      targetLanguage,
      status: 'unavailable',
      progress: null,
      completedSegments: 0,
      totalSegments: 0,
      error: 'TRANSLATOR_UNAVAILABLE'
    };
  }

  /**
   * Cache entries can be shared by separate jobs whose transcript text is
   * identical. Rebind their segment ids to the receiving document so the
   * translated column and semantic selection still line up.
   */
  private bindCachedTranslation(
    cached: TranslationDocument,
    document: TranscriptionDocument,
    requestId?: string
  ): TranslationDocument | null {
    if (cached.segments.length !== document.segments.length) return null;
    return {
      ...cached,
      requestId,
      totalSegments: document.segments.length,
      completedSegments: document.segments.length,
      segments: cached.segments.map((segment, index) => ({
        ...segment,
        sourceSegmentId: document.segments[index].id,
        alignments: segment.alignments.map(link => ({ ...link }))
      }))
    };
  }

  private alignmentIsCurrent(translation: TranslationDocument): boolean {
    const aligner = this.aligner;
    return (
      !aligner?.available() ||
      (translation.alignmentStatus === 'completed' &&
        translation.alignmentModelVersion === aligner.modelVersion())
    );
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

  private async withTranslationRequestLock<T>(
    jobId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.translationRequestOperations.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.translationRequestOperations.set(jobId, tail);
    try {
      return await current;
    } finally {
      if (this.translationRequestOperations.get(jobId) === tail) {
        this.translationRequestOperations.delete(jobId);
      }
    }
  }

  /**
   * Flushes an in-flight translation's segment counter to the sidecar so the
   * polling client can show a real progress bar + ETA. Throttled to at most one
   * write every 300ms (the final segment always lands via the completed doc),
   * and guarded by generation so a superseded task can't rewrite progress.
   */
  private async persistTranslationProgress(
    task: TranslationTask,
    key: string,
    completed: number,
    total: number
  ): Promise<void> {
    const now = Date.now();
    if (completed < total && now - this.lastProgressWrite < 300) return;
    this.lastProgressWrite = now;
    const updated = await this.mutateDocument(task.jobId, fresh => {
      if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
      const doc = fresh.translations[task.language];
      if (!doc || doc.status !== 'processing') return null;
      doc.completedSegments = completed;
      doc.totalSegments = total;
      return doc;
    });
    if (updated) {
      this.setTranslationSummary(task.jobId, updated);
      this.notify('transcription:progress');
    }
  }

  /**
   * Requests a translation into `language`. A cached completed translation from
   * the current model resolves instantly. Otherwise the request is queued with
   * a fresh generation number. Repeating the current in-flight target joins
   * that work instead of restarting it; choosing another target supersedes the
   * old task. Requires an available translator; without one it reports
   * `unavailable` while retaining the requested target in lightweight state.
   */
  async requestTranslation(
    id: string,
    language: string,
    requestId?: string
  ): Promise<TranslationRequestOutcome> {
    return this.withTranslationRequestLock(id, () =>
      this.requestTranslationUnlocked(id, language, requestId)
    );
  }

  private async requestTranslationUnlocked(
    id: string,
    language: string,
    requestId?: string
  ): Promise<TranslationRequestOutcome> {
    const document = await this.document(id);
    if (!document) return { outcome: 'no-document' };
    if (!isValidTargetLanguage(language)) return { outcome: 'invalid-language' };
    const lang = normalizeTargetLanguage(language);
    const modelVersion = this.translationModelVersion();
    const translatorAvailable = this.translator?.available() === true;
    const cacheKey =
      modelVersion === undefined
        ? undefined
        : translationCacheKey({
            sourceContentHash: sourceContentHash(document.segments),
            sourceLanguage: document.sourceLanguage,
            targetLanguage: lang,
            translatorModelVersion: modelVersion
          });
    const cached = document.translations[lang];
    const key = this.translationKey(id, lang);
    const currentGeneration = this.translationGenerations.get(key);
    const taskIsCurrent =
      currentGeneration !== undefined &&
      ((this.activeTranslation?.key === key &&
        this.activeTranslation.generation === currentGeneration) ||
        this.translationTasks.some(
          task =>
            task.jobId === id && task.language === lang && task.generation === currentGeneration
        ));

    if (
      cached &&
      (cached.status === 'queued' || cached.status === 'processing') &&
      cached.modelVersion === modelVersion &&
      cached.cacheKey === cacheKey &&
      taskIsCurrent
    ) {
      this.setTranslationSummary(id, cached);
      return { outcome: 'queued', translation: cached };
    }

    // A new target (including one served from cache) supersedes all older work
    // for this document so an obsolete task cannot consume the shared queue.
    this.cancelTranslationsForJob(id);

    if (
      cached &&
      cached.status === 'completed' &&
      modelVersion !== undefined &&
      cached.modelVersion === modelVersion &&
      cached.cacheKey === cacheKey &&
      (this.alignmentIsCurrent(cached) || !translatorAvailable)
    ) {
      this.setTranslationSummary(id, cached);
      this.notify();
      return { outcome: 'completed', translation: cached };
    }

    let previousTranslation = cached;
    if (cacheKey) {
      const sharedCached = await this.translationCache.load(cacheKey);
      if (sharedCached && (this.alignmentIsCurrent(sharedCached) || !translatorAvailable)) {
        const rebound = this.bindCachedTranslation(sharedCached, document, requestId);
        if (!rebound) {
          previousTranslation = cached;
        } else {
          const saved = await this.mutateDocument(id, fresh => {
            fresh.translations[lang] = rebound;
            return true;
          });
          if (!saved) return { outcome: 'no-document' };
          this.setTranslationSummary(id, rebound);
          this.notify();
          return { outcome: 'completed', translation: rebound };
        }
      } else {
        previousTranslation = cached;
      }
    }

    if (!translatorAvailable || !this.translator) {
      this.setTranslationUnavailable(id, lang);
      this.notify();
      return { outcome: 'unavailable' };
    }

    const generation = (this.translationGenerations.get(key) ?? 0) + 1;
    this.translationGenerations.set(key, generation);

    const pending: TranslationDocument = {
      requestId,
      targetLanguage: lang,
      modelVersion: modelVersion ?? this.translator.modelVersion(),
      cacheKey,
      alignmentModelVersion: this.aligner?.modelVersion(),
      alignmentStatus: 'fallback',
      status: 'queued',
      totalSegments: document.segments.length,
      completedSegments: 0,
      segments: previousTranslation?.segments ?? [],
      error: null
    };
    const saved = await this.mutateDocument(id, fresh => {
      fresh.translations[lang] = pending;
      return true;
    });
    if (!saved) return { outcome: 'no-document' };
    // A concurrent newer request for the same target won the sidecar lock.
    // It owns cancellation/queue mutation from this point onward.
    if ((this.translationGenerations.get(key) ?? 0) !== generation) {
      return { outcome: 'queued', translation: pending };
    }

    this.translationTasks.push({ jobId: id, language: lang, generation, requestId });
    this.setTranslationSummary(id, pending);
    this.notify();
    void this.pumpTranslations();
    return { outcome: 'queued', translation: pending };
  }

  private transcriptionWorkPending(): boolean {
    return (
      this.inFlight || this.jobs.some(job => job.status === 'queued' || job.status === 'processing')
    );
  }

  /**
   * Whisper always owns the shared resource. A translation that was already
   * running when a new transcription batch starts is aborted and requeued by
   * `pumpTranslations`, preserving its generation and FIFO position.
   */
  private preemptTranslationForTranscription(): void {
    const active = this.activeTranslation;
    if (!active || active.preemptedByTranscription) return;
    active.preemptedByTranscription = true;
    active.controller.abort();
  }

  private async requeuePreemptedTranslation(task: TranslationTask, key: string): Promise<void> {
    const queued = await this.mutateDocument(task.jobId, document => {
      if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
      const translation = document.translations[task.language];
      if (!translation || translation.status === 'completed') return null;
      translation.status = 'queued';
      translation.completedSegments = 0;
      translation.totalSegments = document.segments.length;
      translation.error = null;
      return translation;
    });
    if (!queued) return;

    const alreadyQueued = this.translationTasks.some(
      candidate =>
        candidate.jobId === task.jobId &&
        candidate.language === task.language &&
        candidate.generation === task.generation
    );
    if (!alreadyQueued) this.translationTasks.unshift(task);
    this.setTranslationSummary(task.jobId, queued);
  }

  /**
   * Processes queued translations one at a time only after every queued
   * transcription has finished. Stale tasks (a newer generation was requested)
   * are skipped; a result whose generation is no longer current is discarded
   * rather than written, so it cannot clobber a newer translation.
   */
  private async pumpTranslations(): Promise<void> {
    if (this.translating || this.transcriptionWorkPending()) return;
    const translator = this.translator;
    if (!translator?.available()) return;

    const task = this.translationTasks.shift();
    if (!task) return;
    const key = this.translationKey(task.jobId, task.language);
    if ((this.translationGenerations.get(key) ?? 0) !== task.generation) {
      queueMicrotask(() => void this.pumpTranslations());
      return;
    }

    // Acquire the shared resource lock before the first filesystem await. The
    // whisper pump can otherwise observe both flags as false in this gap and
    // start a multi-gigabyte model concurrently with TranslateGemma.
    this.translating = true;
    const controller = new AbortController();
    this.activeTranslation = {
      key,
      generation: task.generation,
      controller,
      preemptedByTranscription: false
    };

    try {
      const preparation = await this.mutateDocument(task.jobId, document => {
        if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
        const processing = document.translations[task.language];
        if (!processing) return null;
        processing.status = 'processing';
        processing.totalSegments = document.segments.length;
        processing.completedSegments = 0;
        return { document, cacheKey: processing.cacheKey, processing };
      });
      if (!preparation) return;
      if (controller.signal.aborted) throw new Error('aborted');
      const { document, cacheKey, processing } = preparation;
      this.setTranslationSummary(task.jobId, processing);
      this.notify('transcription:progress');

      // Another identical document may have finished while this task waited in
      // the single local inference queue. Re-check the shared cache at execution
      // time so the same source/language/model tuple is never inferred twice.
      if (cacheKey) {
        const sharedCached = await this.translationCache.load(cacheKey);
        if (controller.signal.aborted) throw new Error('aborted');
        if (sharedCached && this.alignmentIsCurrent(sharedCached)) {
          const rebound = this.bindCachedTranslation(sharedCached, document, task.requestId);
          if (rebound) {
            const reused = await this.mutateDocument(task.jobId, fresh => {
              if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return false;
              fresh.translations[task.language] = rebound;
              return true;
            });
            if (reused) this.setTranslationSummary(task.jobId, rebound);
            return;
          }
        }
      }

      const total = document.segments.length;
      const sourceById = new Map(document.segments.map(segment => [segment.id, segment]));
      const aligned: TranslationOutputSegment[] = new Array(total);
      const alignPromises: Promise<void>[] = new Array(total);
      let translatedCount = 0;

      // Align a translated segment on the CPU E5 model. Runs concurrently with
      // the remaining GPU translations (different process + device), so the
      // alignment pass overlaps translation instead of following it. Never
      // throws: an alignment failure falls back to the approximate whole-segment
      // highlight, matching the original per-segment behavior.
      const startAlign = (translated: TranslationOutputSegment, index: number): void => {
        alignPromises[index] = (async () => {
          const source = sourceById.get(translated.sourceSegmentId);
          let alignments = translated.alignments;
          if (source && this.aligner?.available()) {
            try {
              alignments = await this.aligner.align(
                {
                  source,
                  translatedText: translated.translatedText,
                  sourceLanguage: document.sourceLanguage,
                  targetLanguage: task.language
                },
                controller.signal
              );
            } catch {
              alignments = [];
            }
          }
          aligned[index] = { ...translated, alignments };
        })();
      };

      const output = await translator.translate(
        {
          sourceLanguage: document.sourceLanguage,
          targetLanguage: task.language,
          segments: document.segments.map(segment => ({
            id: segment.id,
            text: segment.sourceText
          })),
          onSegment: (translated, index) => {
            startAlign(translated, index);
            translatedCount += 1;
            void this.persistTranslationProgress(task, key, translatedCount, total);
          }
        },
        controller.signal
      );
      // Translators that don't emit onSegment (or any segment it missed) still
      // get aligned here; already-started indices are left untouched.
      output.forEach((translated, index) => {
        if (!alignPromises[index]) startAlign(translated, index);
      });
      await Promise.all(alignPromises.filter(Boolean));
      if (controller.signal.aborted) throw new Error('aborted');
      const alignedOutput: TranslationOutputSegment[] = aligned.filter(Boolean);
      // Only persist if this is still the current generation. A stale result is
      // dropped (a newer request already superseded it).
      let completedForCache: TranslationDocument | null = null;
      await this.mutateDocument(task.jobId, fresh => {
        if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return false;
        const completed: TranslationDocument = {
          requestId: task.requestId,
          targetLanguage: task.language,
          modelVersion: translator.modelVersion(),
          cacheKey,
          alignmentModelVersion: this.aligner?.modelVersion(),
          alignmentStatus:
            this.aligner?.available() &&
            alignedOutput.every(
              segment => !segment.translatedText.trim() || segment.alignments.length > 0
            )
              ? 'completed'
              : 'fallback',
          status: 'completed',
          totalSegments: alignedOutput.length,
          completedSegments: alignedOutput.length,
          segments: alignedOutput,
          error: null
        };
        fresh.translations[task.language] = completed;
        completedForCache = completed;
        return true;
      });
      if (completedForCache) {
        this.setTranslationSummary(task.jobId, completedForCache);
        await this.translationCache.save(completedForCache).catch(() => {});
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      const preempted =
        aborted &&
        this.activeTranslation?.key === key &&
        this.activeTranslation.generation === task.generation &&
        this.activeTranslation.preemptedByTranscription;
      if (preempted && (this.translationGenerations.get(key) ?? 0) === task.generation) {
        await this.requeuePreemptedTranslation(task, key);
      } else if (!aborted) {
        const failed = await this.mutateDocument(task.jobId, fresh => {
          if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
          const previous = fresh.translations[task.language];
          const failure: TranslationDocument = {
            requestId: task.requestId,
            targetLanguage: task.language,
            modelVersion: translator.modelVersion(),
            cacheKey: previous?.cacheKey,
            alignmentModelVersion: this.aligner?.modelVersion(),
            alignmentStatus: previous?.alignmentStatus ?? 'fallback',
            status: 'failed',
            segments: previous?.segments ?? [],
            error: error instanceof Error ? error.message : 'TRANSLATION_FAILED'
          };
          fresh.translations[task.language] = failure;
          return failure;
        });
        if (failed) this.setTranslationSummary(task.jobId, failed);
      }
    } finally {
      this.translating = false;
      this.activeTranslation = null;
      this.notify();
      queueMicrotask(() => void this.pump());
      queueMicrotask(() => void this.pumpTranslations());
    }
  }

  state(): TranscriptionState {
    const translatorModel = combinedModelStatus(
      TRANSLATION_MODEL_DESCRIPTOR.label,
      [this.translatorDownloader.status(), this.translatorRuntimeDownloader.status()],
      this.translationDownloadBatchId
    );
    return {
      // The browser operates exclusively on opaque job ids. Keep local source,
      // and diagnostic paths inside the agent process instead of exposing them
      // through state/SSE.
      jobs: this.jobs.map(job => ({
        ...job,
        inputPath: '',
        text: null,
        errorDetails: null
      })),
      running: this.inFlight || this.translating || this.translationTasks.length > 0,
      tools: { ...this.tools, model: modelPresent() },
      model: this.downloader.status(),
      translatorModel,
      translatorRuntime: this.translatorRuntimeDownloader.status(),
      alignmentModel: this.alignmentDownloader.status(),
      settings: { ...this.settings }
    };
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
      this.translating ||
      this.downloader.status().downloading ||
      this.translatorDownloader.status().downloading ||
      this.translatorRuntimeDownloader.status().downloading ||
      this.alignmentDownloader.status().downloading
    );
  }

  modelStatus(): TranscriptionModelInfo {
    return this.downloader.status();
  }

  startModelDownload(): void {
    const downloadBatchId = randomUUID();
    void this.downloader.start(downloadBatchId);
    // A single first-run confirmation installs every local model needed by the
    // bilingual transcript. Transcription itself remains usable if either
    // translation component fails.
    this.startTranslatorModelDownload(downloadBatchId);
  }

  cancelModelDownload(): void {
    this.downloader.cancel();
    this.cancelTranslatorModelDownload();
  }

  setToolAvailability(tools: TranscriptionTooling): void {
    const changed = this.tools.ffmpeg !== tools.ffmpeg || this.tools.whisper !== tools.whisper;
    this.tools = { ...tools };
    if (changed) this.notify();
  }

  updateSettings(patch: Partial<TranscriptionSettings>): void {
    if (typeof patch.language === 'string' && patch.language) {
      this.settings.language = patch.language;
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
    if (translationLanguageChanged) this.resumeAutomaticTranslations();
  }

  private resumeAutomaticTranslations(): void {
    for (const job of this.jobs) {
      if (
        job.status === 'completed' &&
        (job.characters ?? 0) > 0 &&
        (!job.translation || job.translation.status === 'unavailable')
      ) {
        void this.requestAutomaticTranslation(job.id);
      }
    }
  }

  private async requestAutomaticTranslation(jobId: string): Promise<void> {
    const document = await this.document(jobId);
    if (!document?.segments.length) return;
    const target = automaticTranslationTarget(
      document.sourceLanguage,
      this.settings.translationLanguage
    );
    if (!target) return;
    await this.requestTranslation(jobId, target);
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

  private async addOne(
    inputPath: string,
    sourceKind: SourceKind,
    sourceKey: string | null,
    fileNameOverride?: string
  ): Promise<SelectionWarning | null> {
    const fileName = fileNameOverride ?? path.basename(inputPath);
    if (!isTranscribableFileName(fileName)) {
      return selectionWarning(fileName, 'unsupported-format', 'This file format is not supported.');
    }
    if (
      sourceKind === 'local' &&
      this.jobs.some(job => path.resolve(job.inputPath) === path.resolve(inputPath))
    ) {
      return selectionWarning(fileName, 'duplicate', 'This file is already in the queue.');
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
    this.notify();

    // Probe duration so the progress bar has a denominator; a probe failure is
    // not fatal — whisper can still run, the bar just stays indeterminate.
    job.durationSeconds = await probeDuration(inputPath).catch(() => null);
    job.status = 'ready';
    this.notify();
    return null;
  }

  async start(ids: string[]): Promise<boolean> {
    const startable = this.jobs.filter(
      job => ids.includes(job.id) && (job.status === 'ready' || job.status === 'cancelled')
    );
    if (!startable.length) return false;
    const batchId = randomUUID();
    for (const job of startable) {
      job.status = 'queued';
      job.batchId = batchId;
      job.progress = null;
      job.error = null;
      job.errorDetails = null;
      job.text = null;
      job.characters = null;
      job.translation = null;
      job.detectedLanguage = null;
      job.finishedAt = null;
      job.requestedLanguage = this.settings.language;
    }
    this.preemptTranslationForTranscription();
    this.notify();
    void this.pump();
    return true;
  }

  cancel(id: string): boolean {
    const job = this.jobs.find(item => item.id === id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      this.notify();
      queueMicrotask(() => void this.pumpTranslations());
      return true;
    }
    if (job.status === 'processing') {
      job.status = 'cancelled';
      this.active?.cancel();
      this.notify();
      return true;
    }
    return false;
  }

  async remove(id: string): Promise<boolean> {
    const job = this.jobs.find(item => item.id === id);
    if (!job) return false;
    if (job.status === 'processing') return false;
    this.cancelTranslationsForJob(id);
    this.jobs = this.jobs.filter(item => item.id !== id);
    await this.cleanupSource(job);
    this.notify();
    queueMicrotask(() => void this.pumpTranslations());
    return true;
  }

  async removeMany(ids: string[]): Promise<void> {
    const removable = this.jobs.filter(job => ids.includes(job.id) && job.status !== 'processing');
    if (!removable.length) return;
    const removableIds = new Set(removable.map(job => job.id));
    for (const id of removableIds) this.cancelTranslationsForJob(id);
    this.jobs = this.jobs.filter(job => !removableIds.has(job.id));
    for (const job of removable) await this.cleanupSource(job);
    this.notify();
    queueMicrotask(() => void this.pumpTranslations());
  }

  async clearCompleted(): Promise<void> {
    const cleared = this.jobs.filter(
      job => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    );
    if (!cleared.length) return;
    const clearedIds = new Set(cleared.map(job => job.id));
    for (const id of clearedIds) this.cancelTranslationsForJob(id);
    this.jobs = this.jobs.filter(job => !clearedIds.has(job.id));
    for (const job of cleared) await this.cleanupSource(job);
    this.notify();
  }

  async retry(id: string): Promise<boolean> {
    const job = this.jobs.find(item => item.id === id);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return false;
    return this.start([id]);
  }

  sourcePath(id: string): string | null {
    return this.jobs.find(job => job.id === id)?.inputPath ?? null;
  }

  async shutdown(): Promise<void> {
    this.cancelModelDownload();
    this.active?.cancel();
    this.active = null;
    this.activeTranslation?.controller.abort();
    await this.translator?.close?.();
    await this.aligner?.close?.();
    await this.mediaPreviews.close();
  }

  private async pump(): Promise<void> {
    // Whisper and translation share one local resource and never run together.
    if (this.inFlight || this.translating) return;
    if (!this.tools.ffmpeg || !this.tools.whisper || !modelPresent()) return;
    const job = this.jobs.find(item => item.status === 'queued');
    if (!job) return;

    this.inFlight = true;
    job.status = 'processing';
    job.startedAt = Date.now();
    job.progress = null;
    this.notify();

    try {
      const handle = transcribe({
        inputPath: job.inputPath,
        language: job.requestedLanguage,
        onProgress: value => {
          if (job.status !== 'processing') return;
          job.progress = value;
          this.notify('transcription:progress');
        }
      });
      this.active = handle;
      const result = await handle.done;
      this.active = null;

      // A cancel during the await flips job.status to 'cancelled'; TS still sees
      // the pre-await 'processing' literal, so widen before comparing. Don't
      // resurrect a cancelled job into completed/failed.
      const cancelledMidRun = (job.status as string) === 'cancelled';
      if (cancelledMidRun || result.cancelled) {
        job.status = 'cancelled';
        job.progress = null;
      } else if (result.code === 0) {
        job.status = 'completed';
        job.progress = 100;
        job.text = result.text;
        job.characters = result.text.length;
        job.detectedLanguage = result.detectedLanguage;
        job.finishedAt = Date.now();
        // Persist the private structured document (segments + word timestamps);
        // failure here must not fail the job.
        await this.withDocumentLock(job.id, () =>
          this.documents.save(buildTranscriptionDocument(job, MODEL_DESCRIPTOR.label, result.words))
        ).catch(() => {});
        // Queue the preferred local translation without delaying the next
        // Whisper job. Inference remains blocked until the transcription queue
        // is empty and is served instantly when already cached.
        void this.requestAutomaticTranslation(job.id).catch(() => {});
      } else {
        job.status = 'failed';
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
      job.status = 'failed';
      job.progress = null;
      job.error = 'The transcription could not be completed.';
      job.errorDetails = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
    } finally {
      this.inFlight = false;
      this.notify();
      // Drain every queued Whisper job before allowing background translation.
      queueMicrotask(() => void this.pump());
      queueMicrotask(() => void this.pumpTranslations());
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
  }

  private cancelTranslationsForJob(jobId: string): void {
    this.translationTasks = this.translationTasks.filter(task => task.jobId !== jobId);
    for (const [key, generation] of this.translationGenerations) {
      if (key.startsWith(`${jobId}|`)) this.translationGenerations.set(key, generation + 1);
    }
    if (this.activeTranslation?.key.startsWith(`${jobId}|`)) {
      this.activeTranslation.controller.abort();
    }
  }
}

/**
 * The translator is usable only when both weights and runtime are present.
 * Report one byte-weighted component to the UI while retaining the raw runtime
 * state separately for diagnostics.
 */
export function combinedModelStatus(
  label: string,
  parts: readonly TranscriptionModelInfo[],
  downloadBatchId?: string | null
): TranscriptionModelInfo {
  const participants = downloadBatchId
    ? parts.filter(part => part.downloadBatchId === downloadBatchId)
    : parts.filter(part => !part.present);
  const sizeBytes = participants.reduce((total, part) => total + Math.max(0, part.sizeBytes), 0);
  const downloadedBytes = participants.reduce(
    (total, part) =>
      total +
      (part.present
        ? Math.max(0, part.sizeBytes)
        : Math.min(Math.max(0, part.downloadedBytes), Math.max(0, part.sizeBytes))),
    0
  );
  const present = parts.every(part => part.present);
  const downloading = parts.some(part => part.downloading);
  return {
    present,
    downloading,
    progress: present
      ? 100
      : downloading && sizeBytes > 0
        ? Math.min(99, Math.floor((downloadedBytes / sizeBytes) * 100))
        : null,
    sizeBytes,
    downloadedBytes,
    downloadBatchId,
    label,
    error: parts.map(part => part.error).find(Boolean) ?? null
  };
}
