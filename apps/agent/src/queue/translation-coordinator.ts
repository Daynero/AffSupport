import {
  TRANSLATION_LIFECYCLE,
  isValidTargetLanguage,
  normalizeTargetLanguage,
  resolveTranslationTarget,
  translationCacheKey,
  type TranscriptionDocument,
  type TranscriptionEventType,
  type TranscriptionJob,
  type TranscriptionSettings,
  type TranscriptionTranslationSummary,
  type TranslationDocument,
  type TranslationStatus
} from '@video-compressor/shared';
import { decideTransition } from './transitions.js';
import { sourceContentHash, type TranslationCacheStore } from '../transcription/document-store.js';
import type { TranslationOutputSegment, Translator } from '../translation/translator.js';
import type { Aligner } from '../translation/aligner.js';
import os from 'node:os';
import { currentPlatform } from '../platform/platform.js';

/** Below this much memory a CPU-only machine does not run the aligner beside the translator. */
const ALIGNMENT_MIN_MEMORY_BYTES = 12 * 1024 ** 3;

export function alignmentFits(
  platform: NodeJS.Platform = currentPlatform(),
  totalMemory: number = os.totalmem()
): boolean {
  return platform === 'darwin' || totalMemory >= ALIGNMENT_MIN_MEMORY_BYTES;
}

/** How often at most an in-flight translation's segments are written to its sidecar. */
const TRANSLATION_PROGRESS_FLUSH_MS = 2_000;

/** A pending translation request; `generation` guards against stale results. */
interface TranslationTask {
  jobId: string;
  language: string;
  generation: number;
  requestId?: string;
}

/** Result of asking the queue to (re)translate a document into a language. */
export type TranslationRequestOutcome =
  | { outcome: 'completed'; translation: TranslationDocument }
  | { outcome: 'queued'; translation: TranslationDocument }
  | { outcome: 'no-document' }
  | { outcome: 'invalid-language' }
  | { outcome: 'unavailable' };

/** The same, for a translation — a sub-run of a transcription. */
function transitionTranslation(translation: TranslationDocument, next: TranslationStatus): boolean {
  if (!decideTransition(TRANSLATION_LIFECYCLE, translation.status, next)) return false;
  translation.status = next;
  return true;
}

/**
 * Installs a translation document, deciding the move from the one it replaces.
 *
 * A translation finishes, fails, or is re-requested by building a **new** document and
 * dropping it into the map — never by editing the old one. That meant three of the four
 * transitions in its lifecycle happened without the decision ever being consulted: the
 * enforcement was live and the tool it was supposed to govern simply went around it. Deciding
 * against the document being replaced is what puts them back inside.
 */
function replaceTranslation(
  translations: Record<string, TranslationDocument>,
  language: string,
  next: TranslationDocument
): void {
  const previous = translations[language];
  // A language with no translation yet is a creation, not a transition; there is no state to
  // move from.
  if (previous) transitionTranslation(previous, next.status);
  translations[language] = next;
}

/**
 * Resolves the per-file automatic target from the preferred UI language via
 * the shared resolver, so the web viewer's default can never disagree with
 * (and thereby supersede) the automatic translation.
 */
export function automaticTranslationTarget(
  sourceLanguage: string,
  preferredLanguage: string
): string | null {
  return resolveTranslationTarget(sourceLanguage, preferredLanguage);
}

export function translationInputForDocument(
  document: TranscriptionDocument,
  targetLanguage: string
): { language: string; segments: Array<{ id: string; text: string }> } {
  const targetBase = normalizeTargetLanguage(targetLanguage).split('-')[0];
  const sourceBase = document.sourceLanguage
    .trim()
    .replaceAll('_', '-')
    .toLowerCase()
    .split('-')[0];
  const pivot = document.translationSource;
  if (pivot && targetBase !== sourceBase) {
    const pivotById = new Map(
      pivot.segments
        .filter(segment => segment.text.trim())
        .map(segment => [segment.sourceSegmentId, segment.text.trim()])
    );
    if (
      pivotById.size === document.segments.length &&
      document.segments.every(segment => pivotById.has(segment.id))
    ) {
      return {
        language: pivot.language,
        segments: document.segments.map(segment => ({
          id: segment.id,
          text: pivotById.get(segment.id) ?? segment.sourceText
        }))
      };
    }
  }
  return {
    language: document.sourceLanguage,
    segments: document.segments.map(segment => ({ id: segment.id, text: segment.sourceText }))
  };
}

/**
 * What the coordinator needs from the queue it serves.
 *
 * The job list and its team markers, the settings, the sidecar under its lock, the one
 * broadcast, and two facts about the other half of the machine: whether whisper has work,
 * and how to wake it once a translation lets go of the shared resource.
 */
export interface TranslationHost {
  readonly jobs: TranscriptionJob[];
  readonly teamJobIds: ReadonlySet<string>;
  readonly settings: TranscriptionSettings;
  notify(event?: TranscriptionEventType): void;
  document(id: string): Promise<TranscriptionDocument | null>;
  mutateDocument<T>(
    jobId: string,
    mutate: (document: TranscriptionDocument) => T
  ): Promise<T | null>;
  transcriptionWorkPending(): boolean;
  resumeTranscription(): void;
}

/**
 * Translation and alignment of finished transcripts.
 *
 * Everything about translating lived inside the transcription queue: request coalescing,
 * generations, the shared cache, resume after preemption, progress flushing, the inference
 * pump. It was the larger half of a two-thousand-line class whose name said "transcription".
 * The queue now owns transcription and asks this for translation; the two still share one
 * rule — whisper and TranslateGemma never run together — which is why the host tells the
 * coordinator when whisper has work and the coordinator wakes whisper when it is done.
 */

const TOOLING_REQUEST_CONCURRENCY = 3;

/** Runs the thunks with at most `limit` in flight; a rejection is swallowed, not fatal. */
async function runBounded(
  work: ReadonlyArray<() => Promise<unknown>>,
  limit: number
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < work.length) {
      const task = work[next++];
      await task().catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, work.length) }, lane));
}

export class TranslationCoordinator {
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
  /**
   * The latest in-flight progress waiting to be written, or null when nothing is. A burst
   * of finished segments updates this and lets the one scheduled flush write the newest.
   */
  private pendingProgressFlush: {
    task: TranslationTask;
    key: string;
    completed: number;
    total: number;
    snapshot: () => TranslationOutputSegment[];
    completedCharacters?: number;
  } | null = null;
  /** Serializes target choices for one job so rapid UI changes preserve order. */
  private translationRequestOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly host: TranslationHost,
    private readonly translationCache: TranslationCacheStore
  ) {}

  /** The installed translator's version, or undefined without one. */
  modelVersion(): string | undefined {
    return this.translator?.modelVersion();
  }

  /** Whether an inference is running right now. */
  get busy(): boolean {
    return this.translating;
  }

  /** How many requests wait behind the running one. */
  get pendingCount(): number {
    return this.translationTasks.length;
  }

  /** Stops the running inference, for shutdown. */
  abortActive(): void {
    this.activeTranslation?.controller.abort();
  }

  async close(): Promise<void> {
    await this.translator?.close?.();
    await this.aligner?.close?.();
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

  translationToolingChanged(): void {
    const requests: Array<() => Promise<unknown>> = [];
    for (const job of this.host.jobs) {
      const summary = job.translation;
      if (job.status !== 'completed' || !summary) continue;
      // `unavailable`: the translator just arrived. `queued` with no task behind it: the
      // process restarted mid-translation and the store kept the request so it can resume
      // from the segments already on disk instead of vanishing.
      const resumable =
        summary.status === 'unavailable' ||
        (summary.status === 'queued' && !this.hasTranslationWork(job.id));
      if (resumable) {
        requests.push(() => this.requestTranslation(job.id, summary.targetLanguage));
      }
    }
    // A finished file with no translation on record — restored from a build that dropped
    // the summary, or transcribed while no target made sense — is asked for its automatic
    // one now, so the row can say whether a translator is missing and offer to install it.
    for (const job of this.host.jobs) {
      if (job.status !== 'completed' || job.translation || this.host.teamJobIds.has(job.id))
        continue;
      if ((job.characters ?? 0) === 0) continue;
      requests.push(() => this.requestAutomaticTranslation(job.id));
    }
    // A few at a time: each request reads and hashes a sidecar, and a restored list of two
    // hundred files fired all at once while the UI was still connecting.
    void runBounded(requests, TOOLING_REQUEST_CONCURRENCY).then(() => this.pumpTranslations());
    void this.pumpTranslations();
  }

  private setTranslationSummary(
    jobId: string,
    translation: TranslationDocument
  ): TranscriptionTranslationSummary | null {
    const job = this.host.jobs.find(candidate => candidate.id === jobId);
    if (!job) return null;
    const total = Math.max(0, translation.totalSegments ?? translation.segments.length);
    const completed =
      translation.status === 'completed'
        ? total
        : Math.min(total, Math.max(0, translation.completedSegments ?? 0));
    // Progress is weighted by source characters when available — segment counts
    // lie when segment lengths vary. Queued work that already carries resumed
    // segments shows its real percentage instead of an indeterminate bar that
    // reads as "restarted".
    const totalCharacters = Math.max(0, translation.totalCharacters ?? 0);
    const completedCharacters = Math.min(
      totalCharacters,
      Math.max(0, translation.completedCharacters ?? 0)
    );
    const ratio =
      totalCharacters > 0
        ? completedCharacters / totalCharacters
        : total > 0
          ? completed / total
          : 0;
    const progress =
      translation.status === 'completed'
        ? 100
        : total > 0 && (translation.status === 'processing' || completed > 0)
          ? Math.min(99, Math.round(ratio * 100))
          : null;
    const summary: TranscriptionTranslationSummary = {
      targetLanguage: translation.targetLanguage,
      status: translation.status,
      progress,
      completedSegments: completed,
      totalSegments: total,
      startedAt: translation.startedAt ?? null,
      error:
        translation.status === 'failed'
          ? translation.error === 'TRANSLATION_CANCELLED'
            ? 'TRANSLATION_CANCELLED'
            : 'TRANSLATION_FAILED'
          : null
    };
    job.translation = summary;
    return summary;
  }

  private setTranslationUnavailable(jobId: string, targetLanguage: string): void {
    const job = this.host.jobs.find(candidate => candidate.id === jobId);
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

  /**
   * Whether alignment runs at all here.
   *
   * The aligner is a second llama-server beside the translator. On Apple Silicon both fit
   * in unified memory; on a CPU-only laptop with eight gigabytes the pair is the likeliest
   * way to page the machine, so alignment is skipped there and the viewer falls back to
   * whole-segment highlights, which it already handles.
   */
  private alignmentAllowed(): boolean {
    return this.aligner?.available() === true && alignmentFits();
  }

  private alignmentIsCurrent(translation: TranslationDocument): boolean {
    const aligner = this.aligner;
    return (
      !this.alignmentAllowed() ||
      !aligner ||
      (translation.alignmentStatus === 'completed' &&
        translation.alignmentModelVersion === aligner.modelVersion())
    );
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
   * Reports an in-flight translation's progress.
   *
   * Two things happen at two different rates. The live summary — what the list and the
   * viewer show — is updated in memory on every segment and broadcast at once, because it is
   * a few numbers. The sidecar, which holds every finished segment so an interrupted run
   * resumes and the viewer can stream them, is rewritten at most every two seconds: it is
   * the whole document, words and earlier translations included, and parsing and
   * re-serialising it three times a second on the event loop was the single heaviest thing
   * the agent did while the GPU was busy. The final segment always lands through the
   * completed document, so nothing is lost to the throttle. Guarded by generation so a
   * superseded task can't rewrite progress.
   */
  private persistTranslationProgress(
    task: TranslationTask,
    key: string,
    processing: TranslationDocument,
    completed: number,
    total: number,
    snapshot: () => TranslationOutputSegment[],
    completedCharacters?: number
  ): void {
    if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return;
    this.setTranslationSummary(task.jobId, {
      ...processing,
      status: 'processing',
      completedSegments: completed,
      totalSegments: total,
      completedCharacters: completedCharacters ?? processing.completedCharacters
    });
    this.host.notify('transcription:progress');

    const scheduled = this.pendingProgressFlush !== null;
    this.pendingProgressFlush = { task, key, completed, total, snapshot, completedCharacters };
    if (scheduled) return;
    const flush = async () => {
      const pending = this.pendingProgressFlush;
      this.pendingProgressFlush = null;
      if (!pending) return;
      this.lastProgressWrite = Date.now();
      await this.host.mutateDocument(pending.task.jobId, fresh => {
        if ((this.translationGenerations.get(pending.key) ?? 0) !== pending.task.generation) {
          return null;
        }
        const doc = fresh.translations[pending.task.language];
        if (!doc || doc.status !== 'processing') return null;
        doc.completedSegments = pending.completed;
        doc.totalSegments = pending.total;
        if (pending.completedCharacters !== undefined) {
          doc.completedCharacters = pending.completedCharacters;
        }
        // Stream finished segments: the viewer renders them while the rest are
        // still translating, and an interrupted run resumes from them instead of
        // starting over from segment 0.
        doc.segments = pending.snapshot();
        return doc;
      });
    };
    const wait = Math.max(0, TRANSLATION_PROGRESS_FLUSH_MS - (Date.now() - this.lastProgressWrite));
    const timer = setTimeout(() => void flush().catch(() => {}), wait);
    timer.unref();
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
    const document = await this.host.document(id);
    if (!document) return { outcome: 'no-document' };
    if (!isValidTargetLanguage(language)) return { outcome: 'invalid-language' };
    const lang = normalizeTargetLanguage(language);
    const modelVersion = this.translationModelVersion();
    const translatorAvailable = this.translator?.available() === true;
    const translationInput = translationInputForDocument(document, lang);
    const cacheInputSegments = document.segments.map((segment, index) => ({
      ...segment,
      sourceText: translationInput.segments[index].text
    }));
    const cacheKey =
      modelVersion === undefined
        ? undefined
        : translationCacheKey({
            sourceContentHash: sourceContentHash(cacheInputSegments),
            sourceLanguage: translationInput.language,
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
      this.host.notify();
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
          const saved = await this.host.mutateDocument(id, fresh => {
            replaceTranslation(fresh.translations, lang, rebound);
            return true;
          });
          if (!saved) return { outcome: 'no-document' };
          this.setTranslationSummary(id, rebound);
          this.host.notify();
          return { outcome: 'completed', translation: rebound };
        }
      } else {
        previousTranslation = cached;
      }
    }

    if (!translatorAvailable || !this.translator) {
      this.setTranslationUnavailable(id, lang);
      this.host.notify();
      return { outcome: 'unavailable' };
    }

    const generation = (this.translationGenerations.get(key) ?? 0) + 1;
    this.translationGenerations.set(key, generation);

    // Partials persisted by an earlier interrupted run of this same request
    // (matching cacheKey ⇒ identical source text, languages, and model) are
    // carried over so the queue resumes instead of re-translating from
    // segment 0. A different cacheKey means the transcript or model changed —
    // those segments are neither displayable nor resumable.
    const sourceCharactersById = new Map(
      document.segments.map(segment => [segment.id, segment.sourceText.length])
    );
    const resumableSegments =
      cacheKey !== undefined && previousTranslation?.cacheKey === cacheKey
        ? previousTranslation.segments.filter(
            segment =>
              segment.translatedText.trim() && sourceCharactersById.has(segment.sourceSegmentId)
          )
        : [];

    const pending: TranslationDocument = {
      requestId,
      targetLanguage: lang,
      modelVersion: modelVersion ?? this.translator.modelVersion(),
      cacheKey,
      alignmentModelVersion: this.aligner?.modelVersion(),
      alignmentStatus: 'fallback',
      status: 'queued',
      totalSegments: document.segments.length,
      completedSegments: resumableSegments.length,
      totalCharacters: document.segments.reduce(
        (sum, segment) => sum + segment.sourceText.length,
        0
      ),
      completedCharacters: resumableSegments.reduce(
        (sum, segment) => sum + (sourceCharactersById.get(segment.sourceSegmentId) ?? 0),
        0
      ),
      startedAt: resumableSegments.length > 0 ? (previousTranslation?.startedAt ?? null) : null,
      segments: resumableSegments,
      error: null
    };
    const saved = await this.host.mutateDocument(id, fresh => {
      replaceTranslation(fresh.translations, lang, pending);
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
    this.host.notify();
    void this.pumpTranslations();
    return { outcome: 'queued', translation: pending };
  }

  /**
   * User-initiated cancel of the job's current translation. Partials persisted
   * so far are kept, so a later retry resumes instead of restarting.
   */
  async cancelTranslation(id: string): Promise<boolean> {
    const job = this.host.jobs.find(candidate => candidate.id === id);
    const lang = job?.translation?.targetLanguage;
    if (!job || !lang) return false;
    return this.withTranslationRequestLock(id, async () => {
      this.cancelTranslationsForJob(id);
      const cancelled = await this.host.mutateDocument(id, document => {
        const translation = document.translations[lang];
        if (
          !translation ||
          (translation.status !== 'queued' && translation.status !== 'processing')
        ) {
          return null;
        }
        if (!transitionTranslation(translation, 'failed')) return null;
        translation.error = 'TRANSLATION_CANCELLED';
        return translation;
      });
      if (cancelled) this.setTranslationSummary(id, cancelled);
      this.host.notify();
      return cancelled !== null;
    });
  }

  /**
   * Whisper always owns the shared resource. A translation that was already
   * running when a new transcription batch starts is aborted and requeued by
   * `pumpTranslations`, preserving its generation and FIFO position.
   */
  preemptTranslationForTranscription(): void {
    const active = this.activeTranslation;
    if (!active || active.preemptedByTranscription) return;
    active.preemptedByTranscription = true;
    active.controller.abort();
  }

  /**
   * Counts work already persisted on a translation doc (segments + weighted
   * source characters) that a resumed run will adopt instead of re-translating.
   */
  private resumedProgress(
    document: TranscriptionDocument,
    translation: TranslationDocument
  ): { segments: number; characters: number; totalCharacters: number } {
    const charactersById = new Map(
      document.segments.map(segment => [segment.id, segment.sourceText.length])
    );
    let segments = 0;
    let characters = 0;
    for (const segment of translation.segments) {
      if (!segment.translatedText.trim()) continue;
      const sourceCharacters = charactersById.get(segment.sourceSegmentId);
      if (sourceCharacters === undefined) continue;
      segments += 1;
      characters += sourceCharacters;
    }
    return {
      segments,
      characters,
      totalCharacters: document.segments.reduce(
        (sum, segment) => sum + segment.sourceText.length,
        0
      )
    };
  }

  private async requeuePreemptedTranslation(task: TranslationTask, key: string): Promise<void> {
    const queued = await this.host.mutateDocument(task.jobId, document => {
      if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
      const translation = document.translations[task.language];
      if (!translation || translation.status === 'completed') return null;
      transitionTranslation(translation, 'queued');
      // Segments persisted incrementally before the preemption stay counted;
      // the resumed run skips them, so the bar must not fall back to zero.
      const resumed = this.resumedProgress(document, translation);
      translation.completedSegments = resumed.segments;
      translation.totalSegments = document.segments.length;
      translation.completedCharacters = resumed.characters;
      translation.totalCharacters = resumed.totalCharacters;
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
  async pumpTranslations(): Promise<void> {
    if (this.translating || this.host.transcriptionWorkPending()) return;
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
      const preparation = await this.host.mutateDocument(task.jobId, document => {
        if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return null;
        const processing = document.translations[task.language];
        if (!processing) return null;
        transitionTranslation(processing, 'processing');
        // First inference start only; a resumed run keeps the original stamp so
        // elapsed/ETA stay continuous across preemption and surfaces.
        processing.startedAt = processing.startedAt ?? Date.now();
        processing.totalSegments = document.segments.length;
        const resumed = this.resumedProgress(document, processing);
        processing.completedSegments = resumed.segments;
        processing.completedCharacters = resumed.characters;
        processing.totalCharacters = resumed.totalCharacters;
        return { document, cacheKey: processing.cacheKey, processing };
      });
      if (!preparation) return;
      if (controller.signal.aborted) throw new Error('aborted');
      const { document, cacheKey, processing } = preparation;
      this.setTranslationSummary(task.jobId, processing);
      this.host.notify('transcription:progress');

      // Another identical document may have finished while this task waited in
      // the single local inference queue. Re-check the shared cache at execution
      // time so the same source/language/model tuple is never inferred twice.
      if (cacheKey) {
        const sharedCached = await this.translationCache.load(cacheKey);
        if (controller.signal.aborted) throw new Error('aborted');
        if (sharedCached && this.alignmentIsCurrent(sharedCached)) {
          const rebound = this.bindCachedTranslation(sharedCached, document, task.requestId);
          if (rebound) {
            const reused = await this.host.mutateDocument(task.jobId, fresh => {
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
      const translationInput = translationInputForDocument(document, task.language);
      const translationTextById = new Map(
        translationInput.segments.map(segment => [segment.id, segment.text])
      );
      const aligned: TranslationOutputSegment[] = new Array(total);
      const alignPromises: Promise<void>[] = new Array(total);
      /** Raw results in document order, snapshotted for incremental persistence. */
      const partial: TranslationOutputSegment[] = new Array(total);
      let translatedCount = 0;
      let translatedCharacters = 0;

      // Align a translated segment on the CPU E5 model. Runs concurrently with
      // the remaining GPU translations (different process + device), so the
      // alignment pass overlaps translation instead of following it. Never
      // throws: an alignment failure falls back to the approximate whole-segment
      // highlight, matching the original per-segment behavior.
      const startAlign = (translated: TranslationOutputSegment, index: number): void => {
        alignPromises[index] = (async () => {
          const source = sourceById.get(translated.sourceSegmentId);
          let alignments = translated.alignments;
          if (source && this.alignmentAllowed() && this.aligner) {
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

      // Adopt segments a previous interrupted run of this same request already
      // translated (provenance is guaranteed by the cacheKey guard where
      // `processing.segments` was populated). They re-align concurrently with
      // the remaining GPU translations but are never re-translated.
      const resumedBySourceId = new Map(
        processing.segments
          .filter(segment => segment.translatedText.trim())
          .map(segment => [segment.sourceSegmentId, segment])
      );
      const missing: { id: string; text: string; index: number }[] = [];
      document.segments.forEach((segment, index) => {
        const resumed = resumedBySourceId.get(segment.id);
        if (resumed) {
          partial[index] = resumed;
          translatedCount += 1;
          translatedCharacters += segment.sourceText.length;
          startAlign(resumed, index);
        } else {
          missing.push({
            id: segment.id,
            text: translationTextById.get(segment.id) ?? segment.sourceText,
            index
          });
        }
      });
      const snapshotSegments = (): TranslationOutputSegment[] =>
        document.segments.map((_, index) => aligned[index] ?? partial[index]).filter(Boolean);

      const output = missing.length
        ? await translator.translate(
            {
              sourceLanguage: translationInput.language,
              targetLanguage: task.language,
              segments: missing.map(segment => ({ id: segment.id, text: segment.text })),
              onSegment: (translated, subsetIndex) => {
                const index = missing[subsetIndex].index;
                partial[index] = translated;
                startAlign(translated, index);
                translatedCount += 1;
                // Progress is displayed against the visible source transcript.
                // A speech-derived English pivot can have a different character
                // count and must not make the bar jump ahead or reach 100% early.
                translatedCharacters += document.segments[index].sourceText.length;
                this.persistTranslationProgress(
                  task,
                  key,
                  processing,
                  translatedCount,
                  total,
                  snapshotSegments,
                  translatedCharacters
                );
              }
            },
            controller.signal
          )
        : [];
      // Translators that don't emit onSegment (or any segment it missed) still
      // get aligned here; already-started indices are left untouched.
      output.forEach((translated, subsetIndex) => {
        const index = missing[subsetIndex].index;
        if (translated && !alignPromises[index]) startAlign(translated, index);
      });
      await Promise.all(alignPromises.filter(Boolean));
      if (controller.signal.aborted) throw new Error('aborted');
      const alignedOutput: TranslationOutputSegment[] = aligned.filter(Boolean);
      // A translator that returned fewer segments than it was given has not finished. Writing
      // what it did return as `completed` showed a translation with holes in it, and — since
      // the cache refuses to bind a document of the wrong length — poisoned the cache for
      // every identical transcript after it. The partials are kept, so a retry resumes.
      if (alignedOutput.length !== total) {
        throw new Error('TRANSLATION_INCOMPLETE');
      }
      // Only persist if this is still the current generation. A stale result is
      // dropped (a newer request already superseded it).
      let completedForCache: TranslationDocument | null = null;
      await this.host.mutateDocument(task.jobId, fresh => {
        if ((this.translationGenerations.get(key) ?? 0) !== task.generation) return false;
        const completed: TranslationDocument = {
          requestId: task.requestId,
          targetLanguage: task.language,
          modelVersion: translator.modelVersion(),
          cacheKey,
          alignmentModelVersion: this.aligner?.modelVersion(),
          alignmentStatus:
            this.alignmentAllowed() &&
            alignedOutput.every(
              segment => !segment.translatedText.trim() || segment.alignments.length > 0
            )
              ? 'completed'
              : 'fallback',
          status: 'completed',
          totalSegments: alignedOutput.length,
          completedSegments: alignedOutput.length,
          totalCharacters: processing.totalCharacters,
          completedCharacters: processing.totalCharacters,
          startedAt: processing.startedAt ?? null,
          segments: alignedOutput,
          error: null
        };
        replaceTranslation(fresh.translations, task.language, completed);
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
        const failed = await this.host.mutateDocument(task.jobId, fresh => {
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
            // Partials persisted before the failure are kept (and counted) so a
            // retry resumes instead of restarting from segment 0.
            totalSegments: previous?.totalSegments,
            completedSegments: previous?.completedSegments,
            totalCharacters: previous?.totalCharacters,
            completedCharacters: previous?.completedCharacters,
            startedAt: previous?.startedAt ?? null,
            segments: previous?.segments ?? [],
            error: error instanceof Error ? error.message : 'TRANSLATION_FAILED'
          };
          replaceTranslation(fresh.translations, task.language, failure);
          return failure;
        });
        if (failed) this.setTranslationSummary(task.jobId, failed);
      }
    } finally {
      this.translating = false;
      this.activeTranslation = null;
      this.host.notify();
      this.host.resumeTranscription();
      queueMicrotask(() => void this.pumpTranslations());
    }
  }

  resumeAutomaticTranslations(): void {
    for (const job of this.host.jobs) {
      // Team jobs never had one to resume, for the reason `pump` gives.
      if (this.host.teamJobIds.has(job.id)) continue;
      if (
        job.status === 'completed' &&
        (job.characters ?? 0) > 0 &&
        (!job.translation || job.translation.status === 'unavailable')
      ) {
        void this.requestAutomaticTranslation(job.id).catch(() => {});
      }
    }
  }

  async requestAutomaticTranslation(jobId: string): Promise<void> {
    const job = this.host.jobs.find(candidate => candidate.id === jobId);
    if (!job || job.status !== 'completed' || (job.characters ?? 0) === 0) return;
    // The language is on the job; the document is not read for a decision that does not
    // need its segments — at boot this runs for every finished file in the list.
    const target = automaticTranslationTarget(
      job.detectedLanguage ?? job.requestedLanguage,
      this.host.settings.translationLanguage
    );
    if (!target) return;
    await this.requestTranslation(jobId, target);
  }

  /**
   * Stops every translation the transcription tool shows: the running one and
   * everything still waiting behind it. Team jobs are skipped for the same
   * reason they are skipped above — they are invisible here, so a stop in this
   * tool must not reach into Team Workspace.
   *
   * Partial segments already persisted are kept, so a retry resumes rather than
   * restarting; this is the same outcome as the per-job translation stop.
   */
  cancelVisibleTranslations(): number {
    const owned = this.host.jobs
      .filter(job => !this.host.teamJobIds.has(job.id))
      .map(job => job.id)
      .filter(id => this.hasTranslationWork(id));
    for (const id of owned) void this.cancelTranslation(id).catch(() => {});
    return owned.length;
  }

  /** True when a job has a translation running or waiting in the local queue. */
  hasTranslationWork(jobId: string): boolean {
    if (this.translationTasks.some(task => task.jobId === jobId)) return true;
    return this.activeTranslation?.key.startsWith(`${jobId}|`) === true;
  }

  cancelTranslationsForJob(jobId: string): void {
    this.translationTasks = this.translationTasks.filter(task => task.jobId !== jobId);
    for (const [key, generation] of this.translationGenerations) {
      if (key.startsWith(`${jobId}|`)) this.translationGenerations.set(key, generation + 1);
    }
    if (this.activeTranslation?.key.startsWith(`${jobId}|`)) {
      this.activeTranslation.controller.abort();
    }
  }

  /**
   * Forgets a job that has left the queue.
   *
   * Generations only ever grew: one entry per job and language for as long as the agent
   * ran, and every cancel walked all of them. A job that is gone has no result left to
   * guard against.
   */
  forgetJob(jobId: string): void {
    this.cancelTranslationsForJob(jobId);
    for (const key of [...this.translationGenerations.keys()]) {
      if (key.startsWith(`${jobId}|`)) this.translationGenerations.delete(key);
    }
  }
}
