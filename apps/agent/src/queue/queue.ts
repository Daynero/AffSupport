import { randomUUID } from 'node:crypto';
import { access, mkdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  clampCrf,
  clampFrameRate,
  clampResolutionLimit,
  clampVideoBitrateKbps,
  draftImageEmbedding,
  encodingFromSettings,
  imageEmbeddingKey,
  jobConfigurationKey,
  type AgentEventType,
  type AgentSettings,
  type CompressionJob,
  type ImageAsset,
  type ImageSlot,
  type JobStatus,
  type QueueBatch,
  type QueueState,
  type SelectionWarning,
  type SourceKind
} from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure, type EncodeEmbeddingOptions } from '../ffmpeg/encoder.js';
import {
  isMediaToolUnavailableError,
  MediaToolUnavailableError,
  probeMedia,
  type MediaInfo,
  type MediaToolName
} from '../ffmpeg/tools.js';
import { fileSize, nextOutputPath } from '../files/paths.js';
import {
  freezeImageEmbedding,
  outputDimensions,
  outputDurationSeconds,
  outputFrameRate,
  refreshEstimateFromBreakdown,
  sourceDurationSeconds
} from '../images/embedding.js';
import { ImageAssetError, ImageAssetStore } from '../images/store.js';
import { detectStaticEdgeTrims } from '../images/static-edges.js';
/**
 * Suspension is NOT done here any more. The governor owns it, because it also
 * duty-cycles managed children to hold the power limit — two independent
 * suspenders would fight over the same process, and whichever resumed last
 * would silently discard the other's intent.
 */

/**
 * What the queue needs from the shared resource budget. Structural so the queue
 * does not depend on the power module's concrete class — and so a bare test
 * assembly can omit it entirely.
 */
export interface QueuePowerGovernor {
  hold(child: ChildProcessWithoutNullStreams, reason: string): () => void;
  /** Whether the child is stopped right now — a hold can fail to land. */
  isSuspended(child: ChildProcessWithoutNullStreams): boolean;
  resumeForTermination(child: ChildProcessWithoutNullStreams): void;
  throttlingSupported(): boolean;
  scaleTimeout(milliseconds: number): number;
}
import { selectionWarning } from './shared.js';

/**
 * How often the drain watchdog looks for a stranded batch. Slow on purpose:
 * this is a safety net for a loop that should never be dropped, not the
 * mechanism that drives it.
 */
const DRAIN_WATCHDOG_MS = 2_000;
import { defaultSettings } from './store.js';

type EstimatorHooks = {
  schedule: () => void;
  invalidate: () => void;
  resume: () => void;
  runPrioritized?: () => Promise<boolean>;
  cancelPrioritized?: (id: string) => void;
};

type RuntimeRecoveryPhase = 'input-analysis' | 'encoding' | 'output-validation';
export type QueueMediaRuntime = { probeMedia: typeof probeMedia };

const defaultMediaRuntime: QueueMediaRuntime = { probeMedia };
const RUNTIME_WARNING = 'Soty media tools became unavailable. The agent is restarting safely.';
const RUNTIME_JOB_ERROR =
  'Soty media tools became unavailable. This task will recover after restart.';

export interface AddSourceOptions {
  sourceKind?: SourceKind;
  sourceKey?: string | null;
  fileName?: string;
  /** Per-operation settings isolated from the interactive queue defaults. */
  settings?: AgentSettings;
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts'
]);

export function isSupportedVideoPath(filePath: string) {
  return SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export class JobQueue {
  private active: ChildProcessWithoutNullStreams | null = null;
  // Aborts background media work for the current job (static-edge detection in
  // `preparing-images`) whose ffmpeg children are not the tracked `active`
  // encoder, so cancel/shutdown can actually stop them.
  private activeAbort: AbortController | null = null;
  private compressionInFlight = false;
  private compressionPausedForEstimates = false;
  private prioritizingEstimates = false;
  private drainWatchdog: NodeJS.Timeout | null = null;
  private nextEstimatePriorityOrder = 1;
  private warning: string | null = null;
  private estimateHooks: EstimatorHooks | null = null;
  private runtimeRecovery: ((error: MediaToolUnavailableError) => void) | null = null;
  private updateState: NonNullable<QueueState['update']> = {
    state: 'none',
    targetBuildId: null
  };
  private imagePool: Record<ImageSlot, string[]> = { start: [], end: [] };
  private knownPoolImages: Record<ImageSlot, Set<string>> = {
    start: new Set(),
    end: new Set()
  };
  private teamJobSettings = new Map<string, AgentSettings>();
  private power: QueuePowerGovernor | null = null;
  /** Releases the estimate-priority hold; null when nothing is held. */
  private estimateHoldRelease: (() => void) | null = null;

  constructor(
    private tools: QueueState['tools'],
    private notify: (event?: AgentEventType) => void,
    private jobs: CompressionJob[] = [],
    private settings: AgentSettings = defaultSettings,
    private batch: QueueBatch | null = null,
    private imageStore = new ImageAssetStore(),
    private random = Math.random,
    private mediaRuntime: QueueMediaRuntime = defaultMediaRuntime
  ) {
    this.nextEstimatePriorityOrder =
      Math.max(0, ...jobs.map(job => job.estimatePriorityOrder ?? 0)) + 1;
    // A batch restored from disk is the case the watchdog exists for: the agent
    // died mid-drain, so nothing is in flight and nothing will call `start()`.
    if (this.batch && !this.batch.finishedAt) this.startDrainWatchdog();
  }

  attachEstimator(hooks: EstimatorHooks) {
    this.estimateHooks = hooks;
  }

  /**
   * Hands the queue the shared resource budget.
   *
   * The queue no longer suspends the active encode itself. Suspension has one
   * owner — the governor — because it also duty-cycles managed children to hold
   * the power limit; two independent suspenders would fight, and the cycler's
   * next on-window would resume a process this queue deliberately stopped.
   * Optional so tests that assemble a bare queue keep working: without a
   * governor the prioritization simply runs alongside the encode, exactly as it
   * does today on a platform that cannot pause.
   */
  attachPowerGovernor(governor: QueuePowerGovernor) {
    this.power = governor;
  }

  /**
   * Asks the governor to hold the encode while prioritized estimates run, and
   * reports whether the encode is actually stopped now.
   *
   * The answer must come from the governor, not from the fact that one is
   * attached: a hold can fail to land — the process is already gone, or the
   * Windows helper could not start — and a caller that assumed success would
   * run estimates alongside a still-running encode while believing it had the
   * machine to itself. The hold is dropped again when it did not take, so
   * nothing is left holding a child down for a handoff that was abandoned.
   */
  private holdForEstimates(child: ChildProcessWithoutNullStreams): boolean {
    if (!this.power) return false;
    const release = this.power.hold(child, 'estimate-priority');
    if (!this.power.isSuspended(child)) {
      release();
      return false;
    }
    this.estimateHoldRelease = release;
    return true;
  }

  private releaseEstimateHold() {
    this.estimateHoldRelease?.();
    this.estimateHoldRelease = null;
  }

  private pauseSupported(): boolean {
    return this.power?.throttlingSupported() ?? false;
  }

  attachRuntimeRecovery(handler: (error: MediaToolUnavailableError) => void) {
    this.runtimeRecovery = handler;
  }

  setToolAvailability(next: QueueState['tools']) {
    const changed = this.tools.ffmpeg !== next.ffmpeg || this.tools.ffprobe !== next.ffprobe;
    const becameAvailable =
      next.ffmpeg && next.ffprobe && (!this.tools.ffmpeg || !this.tools.ffprobe);
    this.tools.ffmpeg = next.ffmpeg;
    this.tools.ffprobe = next.ffprobe;
    if (next.ffmpeg && next.ffprobe && this.warning === RUNTIME_WARNING) this.warning = null;
    if (changed) this.notify();
    // A transient tool outage can make `pump` bail while a batch still has
    // queued jobs; once the tools return, resume draining it so those jobs do
    // not stay wedged as "running" until the agent restarts.
    if (becameAvailable && !this.compressionInFlight) queueMicrotask(() => void this.pump());
  }

  state(): QueueState {
    return {
      jobs: this.jobs.filter(job => !this.teamJobSettings.has(job.id)).map(job => cloneJob(job)),
      running: this.running(),
      tools: this.tools,
      settings: cloneSettings(this.settings),
      batch: this.batch ? { ...this.batch, jobIds: [...this.batch.jobIds] } : null,
      warning: this.warning,
      update: this.updateStatus()
    };
  }

  /**
   * The three cheap reads `state()` is otherwise asked for.
   *
   * `state()` clones every job. The health endpoints want only the update
   * status, the diagnostics endpoint only the last warning, and callers like
   * `workActive()` only a boolean — and `/health` is polled once a second by
   * the launcher, so cloning a two-hundred-file queue to answer any of them is
   * pure waste.
   */
  running(): boolean {
    return this.compressionInFlight || this.prioritizingEstimates || this.queuedInBatch();
  }

  updateStatus(): NonNullable<QueueState['update']> {
    return { ...this.updateState };
  }

  warningMessage(): string | null {
    return this.warning;
  }

  compressionActive() {
    return this.compressionInFlight && !this.compressionPausedForEstimates;
  }

  workActive() {
    return this.running();
  }

  acceptingNewTasks() {
    return this.updateState.state === 'none';
  }

  requestUpdateDrain(targetBuildId: string) {
    if (!targetBuildId || targetBuildId === this.updateState.targetBuildId) return;
    this.updateState = {
      state: this.workActive() ? 'draining' : 'pending',
      targetBuildId
    };
    this.notify();
  }

  persisted() {
    const durableJobs = this.jobs.filter(job => !this.teamJobSettings.has(job.id));
    return {
      jobs: durableJobs.map(job => cloneJob(job)),
      settings: cloneSettings(this.settings),
      batch: this.batch
        ? {
            ...this.batch,
            jobIds: this.batch.jobIds.filter(id => !this.teamJobSettings.has(id))
          }
        : null
    };
  }

  teamJob(sourceKey: string): CompressionJob | null {
    const job = this.jobs.find(candidate => candidate.sourceKey === sourceKey);
    return job && this.teamJobSettings.has(job.id) ? cloneJob(job) : null;
  }

  async updateSettings(next: Partial<AgentSettings>) {
    const normalized: Partial<AgentSettings> = { ...next };
    if (next.frameRate !== undefined && next.frameRate !== null) {
      normalized.frameRate = clampFrameRate(next.frameRate);
    }
    if (next.crf !== undefined) normalized.crf = clampCrf(next.crf);
    if (next.videoBitrateKbps !== undefined) {
      normalized.videoBitrateKbps = clampVideoBitrateKbps(next.videoBitrateKbps);
    }
    if (next.resolutionLimit !== undefined && next.resolutionLimit !== null) {
      normalized.resolutionLimit = clampResolutionLimit(next.resolutionLimit);
    }
    if (next.imageEmbedding !== undefined) {
      normalized.imageEmbedding = cloneImageEmbeddingSettings(next.imageEmbedding);
    }

    const encodingChanged = (
      [
        'mode',
        'stripMetadata',
        'frameRate',
        'resolutionLimit',
        'rateControl',
        'crf',
        'videoBitrateKbps'
      ] as const
    ).some(key => normalized[key] !== undefined && normalized[key] !== this.settings[key]);
    const imageSettingsChanged =
      normalized.imageEmbedding !== undefined &&
      imageEmbeddingSettingsKey(normalized.imageEmbedding) !==
        imageEmbeddingSettingsKey(this.settings.imageEmbedding);
    const previousEffectiveEmbedding = imageEmbeddingKey(
      draftImageEmbedding(this.settings.imageEmbedding)
    );
    const outputChanged = (['outputMode', 'outputFolder'] as const).some(
      key => normalized[key] !== undefined && normalized[key] !== this.settings[key]
    );
    this.settings = {
      ...this.settings,
      ...normalized,
      imageEmbedding: normalized.imageEmbedding ?? this.settings.imageEmbedding
    };
    const imageEmbeddingChanged =
      imageSettingsChanged &&
      previousEffectiveEmbedding !==
        imageEmbeddingKey(draftImageEmbedding(this.settings.imageEmbedding));

    if (encodingChanged || imageEmbeddingChanged) {
      const encoding = encodingFromSettings(this.settings);
      const imageEmbedding = draftImageEmbedding(this.settings.imageEmbedding);
      for (const job of this.jobs) {
        if (this.teamJobSettings.has(job.id)) continue;
        if (!['analyzing', 'ready', 'failed', 'cancelled', 'interrupted'].includes(job.status))
          continue;
        if (encodingChanged) job.encoding = { ...encoding };
        if (imageEmbeddingChanged) job.imageEmbedding = cloneJobImageEmbedding(imageEmbedding);
        resetEstimate(job);
      }
      this.estimateHooks?.invalidate();
    }

    if (outputChanged || imageEmbeddingChanged) {
      for (const job of this.jobs) {
        if (this.teamJobSettings.has(job.id)) continue;
        if (!['analyzing', 'ready', 'failed', 'cancelled', 'interrupted'].includes(job.status))
          continue;
        job.outputPath = await this.outputPathFor(job.inputPath, job);
      }
    }
    this.notify();
  }

  async setImage(slot: ImageSlot, asset: ImageAsset | null) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    imageEmbedding[key] = asset ? [{ ...asset }] : [];
    await this.updateSettings({ imageEmbedding });
  }

  async addImage(slot: ImageSlot, asset: ImageAsset) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    if (!imageEmbedding[key].some(candidate => candidate.id === asset.id)) {
      imageEmbedding[key].push({ ...asset });
    }
    await this.updateSettings({ imageEmbedding });
  }

  async removeImage(slot: ImageSlot, id: string) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    const previous = imageEmbedding[key].find(asset => asset.id === id) ?? null;
    if (!previous) return null;
    imageEmbedding[key] = imageEmbedding[key].filter(asset => asset.id !== id);
    await this.updateSettings({ imageEmbedding });
    return previous;
  }

  imageAsset(id: string) {
    const settingsAssets = [
      ...this.settings.imageEmbedding.startImages,
      ...this.settings.imageEmbedding.endImages
    ];
    const jobAssets = this.jobs.flatMap(job => [
      job.imageEmbedding?.startImage ?? null,
      job.imageEmbedding?.endImage ?? null
    ]);
    return [...settingsAssets, ...jobAssets].find(asset => asset?.id === id) ?? null;
  }

  async releaseImageIfUnused(asset: ImageAsset | null) {
    if (asset && !this.imageAsset(asset.id)) await this.imageStore.remove(asset);
  }

  async revalidateSettingsImages() {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    let changed = false;
    const invalidAssets: ImageAsset[] = [];
    for (const slot of ['startImages', 'endImages'] as const) {
      const valid: ImageAsset[] = [];
      for (const asset of imageEmbedding[slot]) {
        try {
          await this.imageStore.validate(asset);
          valid.push(asset);
        } catch {
          changed = true;
          invalidAssets.push(asset);
        }
      }
      imageEmbedding[slot] = valid;
    }
    if (changed) {
      await this.updateSettings({ imageEmbedding });
      for (const asset of invalidAssets) void this.releaseImageIfUnused(asset);
    }
    return changed;
  }

  async recoverRuntimeInterruptedJobs() {
    for (const job of this.jobs) {
      const recovery = parseRuntimeRecovery(job.errorDetails);
      if (!recovery) continue;
      try {
        if (recovery.phase === 'input-analysis') {
          const media = await this.mediaRuntime.probeMedia(job.inputPath);
          if (!validSourceMedia(media)) {
            job.status = 'failed';
            job.error = 'This video format is not supported or the file is damaged.';
            job.errorDetails = null;
            job.finishedAt = finishTimestamp(job);
            continue;
          }
          applySourceMedia(job, media);
          job.status = 'ready';
          job.error = null;
          job.errorDetails = null;
          job.finishedAt = null;
          this.estimateHooks?.schedule();
          continue;
        }

        if (recovery.phase === 'output-validation') {
          await access(job.outputPath);
          const media = await this.mediaRuntime.probeMedia(job.outputPath);
          await this.completeJob(job, media);
          continue;
        }

        job.status = 'interrupted';
        job.error = 'Compression was interrupted when the media engine stopped.';
        job.errorDetails = null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
      } catch (error) {
        if (isMediaToolUnavailableError(error)) {
          await this.pauseForRuntimeFailure(job, error, recovery.phase);
          return false;
        }
        job.status = 'failed';
        job.error = processingError(error);
        job.errorDetails = error instanceof Error ? error.message : null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
      }
    }
    this.notify();
    return true;
  }

  embeddingConfigurationError() {
    const embedding = this.settings.imageEmbedding;
    if (embedding.enabled && !embedding.startImages.length && !embedding.endImages.length) {
      return 'EMBED_IMAGES_REQUIRED';
    }
    return null;
  }

  async add(paths: string[], allowWarnings = false): Promise<SelectionWarning[]> {
    const warnings: SelectionWarning[] = [];
    for (const inputPath of paths) {
      const result = await this.addOne(inputPath, {}, allowWarnings);
      if (result) warnings.push(result);
    }
    return warnings;
  }

  async addUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(
      inputPath,
      { sourceKind: 'uploaded', fileName, sourceKey },
      false
    );
    return warning ? [warning] : [];
  }

  async addTeamUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string,
    settings: AgentSettings
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(
      inputPath,
      {
        sourceKind: 'uploaded',
        fileName,
        sourceKey,
        settings: cloneSettings(settings)
      },
      false
    );
    return warning ? [warning] : [];
  }

  async start(ids: string[]) {
    if (
      !this.tools.ffmpeg ||
      !this.tools.ffprobe ||
      !this.acceptingNewTasks() ||
      this.state().running
    )
      return false;
    const requested = new Set(ids);
    const rerunnable = this.jobs.filter(
      job =>
        requested.has(job.id) &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
    );
    for (const job of rerunnable) await this.resetForRerun(job);
    const jobs = this.jobs.filter(job => requested.has(job.id) && job.status === 'ready');
    if (!jobs.length) return false;
    if (
      jobs.some(job => {
        const embedding = (this.teamJobSettings.get(job.id) ?? this.settings).imageEmbedding;
        return embedding.enabled && !embedding.startImages.length && !embedding.endImages.length;
      })
    ) {
      return false;
    }

    const batch: QueueBatch = {
      id: randomUUID(),
      jobIds: jobs.map(job => job.id),
      startedAt: Date.now(),
      finishedAt: null
    };
    // Resolve every output path (which can throw on an unwritable/missing
    // folder) BEFORE mutating any job or the batch. A throw mid-loop must never
    // leave jobs marked `queued` with no `pump` running, which would wedge
    // `running=true` until the agent restarts.
    const warning = await this.diskWarning(jobs);
    const prepared: {
      job: CompressionJob;
      imageEmbedding: CompressionJob['imageEmbedding'];
      outputPath: string;
    }[] = [];
    for (const job of jobs) {
      const jobSettings = this.teamJobSettings.get(job.id) ?? this.settings;
      const estimatedEmbedding = job.imageEmbedding;
      const selectedImages = jobSettings.imageEmbedding.enabled
        ? {
            startImage: this.drawImage('start', jobSettings.imageEmbedding.startImages),
            endImage: this.drawImage('end', jobSettings.imageEmbedding.endImages)
          }
        : { startImage: null, endImage: null };
      const imageEmbedding = freezeImageEmbedding(
        jobSettings.imageEmbedding,
        this.random,
        selectedImages
      );
      if (imageEmbedding?.replaceExisting && estimatedEmbedding?.replaceExisting) {
        imageEmbedding.sourceTrimStartSeconds = estimatedEmbedding.sourceTrimStartSeconds;
        imageEmbedding.sourceTrimEndSeconds = estimatedEmbedding.sourceTrimEndSeconds;
      }
      // Reserve against paths already committed in this loop as well as the
      // other jobs' current paths, so two started jobs never collide.
      const reserved = prepared.map(entry => entry.outputPath);
      const outputPath = await this.outputPathFor(job.inputPath, job, jobSettings, reserved);
      prepared.push({ job, imageEmbedding, outputPath });
    }

    this.batch = batch;
    this.startDrainWatchdog();
    this.warning = warning;
    for (const { job, imageEmbedding, outputPath } of prepared) {
      const draftKey = jobConfigurationKey(job.encoding, job.imageEmbedding);
      job.imageEmbedding = imageEmbedding;
      job.outputPath = outputPath;
      if (
        draftKey !== jobConfigurationKey(job.encoding, job.imageEmbedding) &&
        !refreshEstimateFromBreakdown(job)
      ) {
        resetEstimate(job);
      }
      job.status = 'queued';
      job.batchId = batch.id;
      job.error = null;
      job.errorDetails = null;
      job.progress = outputDurationSeconds(job) ? 0 : null;
      job.processingStage = null;
      job.startedAt = null;
      job.finishedAt = null;
    }
    this.notify();
    void this.pump();
    return true;
  }

  async cancel(id: string) {
    const cancelled = await this.cancelJob(id);
    if (cancelled) this.notify('estimate:queued');
    return cancelled;
  }

  /** Cancels one job without broadcasting; the caller decides when to notify. */
  private async cancelJob(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || (job.status !== 'processing' && job.status !== 'queued')) return false;
    const wasProcessing = job.status === 'processing';
    job.status = 'cancelled';
    job.error = 'Compression was cancelled.';
    job.finishedAt = finishTimestamp(job);
    job.processingStage = null;
    resetEstimate(job);
    if (wasProcessing) {
      // Stop untracked background work too (static-edge detection during
      // `preparing-images`), whose ffmpeg children are not `this.active` and
      // would otherwise keep loading the CPU after the UI shows "cancelled".
      this.activeAbort?.abort();
      // SIGTERM is not delivered to a stopped process until it is resumed, so a
      // suspended encode would ignore the graceful signal and only die to the
      // SIGKILL escalation — losing the chance to finalize its output.
      this.releaseEstimateHold();
      if (this.active) this.power?.resumeForTermination(this.active);
      if (this.active) this.active.kill('SIGTERM');
    }
    return true;
  }

  /**
   * Stops the whole visible batch in one action. Queued jobs are cancelled
   * first so the pump cannot pick another one up while the active encode is
   * still being torn down, and team jobs are skipped: they never appear in the
   * compressor UI, so a "stop all" there must not kill Team Workspace work.
   */
  async cancelAll(): Promise<number> {
    const stoppable = (status: JobStatus) =>
      this.jobs
        .filter(job => job.status === status && !this.teamJobSettings.has(job.id))
        .map(job => job.id);
    const ids = [...stoppable('queued'), ...stoppable('processing')];
    let stopped = 0;
    // One broadcast at the end, not one per job: cancelling a hundred-file
    // queue would otherwise push a hundred full `QueueState` frames — each a
    // clone of every job — down every open SSE connection.
    for (const id of ids) if (await this.cancelJob(id)) stopped += 1;
    if (!stopped) return 0;
    // Close the batch out. Nothing else will when only queued jobs were
    // stopped: the drain loop has no work left to finish on, so the batch would
    // keep its null `finishedAt` and the watchdog would tick for the rest of
    // the session looking for a queue that is already empty. When a running
    // encode was cancelled the batch closes on its way out instead.
    this.closeBatchIfDrained();
    this.notify('estimate:queued');
    return stopped;
  }

  prioritizeEstimate(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (
      !this.state().running ||
      !job ||
      job.status !== 'queued' ||
      !['waiting', 'cancelled'].includes(job.estimateStatus) ||
      job.estimatePriorityOrder !== null
    ) {
      return false;
    }
    job.estimatePriorityOrder = this.nextEstimatePriorityOrder++;
    job.estimateStatus = 'waiting';
    job.estimateProgress = null;
    job.estimateError = null;
    this.notify('estimate:queued');
    void this.runPrioritizedEstimates();
    return true;
  }

  cancelPrioritizedEstimate(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.estimatePriorityOrder === null) return false;
    job.estimatePriorityOrder = null;
    if (job.estimateStatus === 'estimating') {
      job.estimateStatus = 'waiting';
      job.estimateProgress = null;
      job.estimateError = null;
    }
    this.estimateHooks?.cancelPrioritized?.(id);
    this.notify('estimate:queued');
    return true;
  }

  remove(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || ['processing', 'queued'].includes(job.status)) return false;
    if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(id);
    const images = jobImages(job);
    this.jobs = this.jobs.filter(candidate => candidate !== job);
    this.teamJobSettings.delete(job.id);
    void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
    return true;
  }

  /**
   * Drops a team job whatever state it is in. Team work is invisible to the
   * compressor UI and is never persisted, so a queued or processing leftover
   * would keep `running` true — greying out the whole tool — with nothing on
   * screen to explain it and no way back short of restarting the agent.
   */
  async discardTeamJob(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return false;
    if (job.status === 'processing' || job.status === 'queued') await this.cancel(id);
    return this.remove(id);
  }

  removeMany(ids: string[]) {
    const selected = new Set(ids);
    const removable = this.jobs.filter(
      job => selected.has(job.id) && !['processing', 'queued'].includes(job.status)
    );
    if (!removable.length) return 0;
    for (const job of removable) {
      if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(job.id);
      this.teamJobSettings.delete(job.id);
    }
    const removed = new Set(removable.map(job => job.id));
    const images = removable.flatMap(jobImages);
    this.jobs = this.jobs.filter(job => !removed.has(job.id));
    for (const job of removable) void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
    return removable.length;
  }

  async retry(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status)) return false;
    await this.resetForRerun(job);
    this.notify('estimate:queued');
    this.estimateHooks?.schedule();
    return true;
  }

  async repeat(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== 'completed') return false;
    return this.start([id]);
  }

  clearCompleted() {
    const removed = this.jobs.filter(job =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
    );
    const images = removed.flatMap(jobImages);
    this.jobs = this.jobs.filter(job => !removed.includes(job));
    for (const job of removed) this.teamJobSettings.delete(job.id);
    for (const job of removed) void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
  }

  outputFolder(): string | null {
    const completed = this.jobs.find(job => job.status === 'completed');
    return completed ? path.dirname(completed.outputPath) : this.settings.outputFolder;
  }

  async shutdown() {
    // Abort background media work first: static-edge detection runs its own
    // ffmpeg children that are not `this.active`, so without this a shutdown
    // during `preparing-images` would leave them running.
    this.activeAbort?.abort();
    const child = this.active;
    if (!child) return;
    this.releaseEstimateHold();
    this.power?.resumeForTermination(child);
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolve => child.once('close', () => resolve())),
      new Promise<void>(resolve =>
        setTimeout(
          () => {
            child.kill('SIGKILL');
            resolve();
          },
          // Throttling stretches wall-clock time, so a fixed grace period would
          // shrink in effective terms exactly when the process needs it most.
          this.power?.scaleTimeout(2000) ?? 2000
        )
      )
    ]);
  }

  updateEstimate(id: string, patch: Partial<CompressionJob>, event: AgentEventType) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status === 'completed') return;
    Object.assign(job, patch);
    this.notify(event);
  }

  estimationJobs() {
    return this.jobs.filter(job => !this.teamJobSettings.has(job.id)).map(job => cloneJob(job));
  }

  private async addOne(
    inputPath: string,
    options: AddSourceOptions,
    allowWarnings: boolean
  ): Promise<SelectionWarning | null> {
    const canonical = path.resolve(inputPath);
    const fileName = options.fileName ?? path.basename(canonical);
    const sourceSettings = options.settings ?? this.settings;
    if (!isSupportedVideoPath(fileName)) {
      return selectionWarning(fileName, 'unsupported-format', 'This file format is not supported.');
    }

    // Re-adding a file that is already in the list is still rejected, but a
    // video that merely looks already-compressed can be re-compressed freely.
    const duplicate = this.jobs.some(job =>
      options.sourceKey
        ? job.sourceKey === options.sourceKey
        : path.resolve(job.inputPath) === canonical
    );
    if (duplicate && !allowWarnings) {
      return selectionWarning(fileName, 'duplicate', 'This video is already in the list.');
    }

    try {
      const size = await fileSize(canonical);
      const sourceKind = options.sourceKind ?? 'local';
      const job: CompressionJob = {
        id: randomUUID(),
        inputPath: canonical,
        outputPath: '',
        fileName,
        sourceKind,
        sourceKey: options.sourceKey ?? null,
        durationSeconds: null,
        originalSize: size,
        sourceWidth: null,
        sourceHeight: null,
        sourceFrameRate: null,
        sourceBitrate: null,
        sourceCodec: null,
        sourceHasAudio: false,
        sourceAudioBitrate: null,
        sourceAudioSampleRate: null,
        sourceAudioChannels: null,
        sourceAudioLayout: null,
        finalSize: null,
        finalWidth: null,
        finalHeight: null,
        finalFrameRate: null,
        finalBitrate: null,
        finalDurationSeconds: null,
        finalCodec: null,
        progress: null,
        processingStage: null,
        status: 'analyzing',
        error: null,
        errorDetails: null,
        encoding: encodingFromSettings(sourceSettings),
        imageEmbedding: draftImageEmbedding(sourceSettings.imageEmbedding),
        batchId: null,
        startedAt: null,
        finishedAt: null,
        estimateStatus: 'waiting',
        estimatedOutputBytes: null,
        estimatedSavingPercent: null,
        estimateRangeMinBytes: null,
        estimateRangeMaxBytes: null,
        estimateProgress: null,
        estimateError: null,
        estimateKey: null,
        estimatePriorityOrder: null,
        estimateBreakdown: null
      };
      job.outputPath = await this.outputPathFor(canonical, job, sourceSettings);
      this.jobs.push(job);
      if (options.settings) this.teamJobSettings.set(job.id, cloneSettings(sourceSettings));
      this.notify();

      if (!this.tools.ffprobe) {
        await this.pauseForRuntimeFailure(
          job,
          new MediaToolUnavailableError('ffprobe'),
          'input-analysis'
        );
        return null;
      }
      let media: MediaInfo;
      try {
        media = await this.mediaRuntime.probeMedia(canonical);
      } catch (error) {
        if (isMediaToolUnavailableError(error)) {
          await this.pauseForRuntimeFailure(job, error, 'input-analysis');
          return null;
        }
        throw error;
      }
      if (!validSourceMedia(media)) {
        job.status = 'failed';
        job.error = 'This video format is not supported or the file is damaged.';
        this.notify();
        return null;
      }
      applySourceMedia(job, media);
      job.progress = 0;
      job.status = 'ready';
      this.notify('estimate:queued');
      this.estimateHooks?.schedule();
      return null;
    } catch {
      return selectionWarning(fileName, 'inaccessible', 'The file is no longer accessible.');
    }
  }

  private async resetForRerun(job: CompressionJob) {
    const jobSettings = this.teamJobSettings.get(job.id) ?? this.settings;
    const previousImages = jobImages(job);
    job.status = 'ready';
    job.error = null;
    job.errorDetails = null;
    job.progress = job.durationSeconds ? 0 : null;
    job.processingStage = null;
    job.finalSize = null;
    job.finalWidth = null;
    job.finalHeight = null;
    job.finalFrameRate = null;
    job.finalBitrate = null;
    job.finalDurationSeconds = null;
    job.finalCodec = null;
    job.startedAt = null;
    job.finishedAt = null;
    job.batchId = null;
    job.encoding = encodingFromSettings(jobSettings);
    job.imageEmbedding = draftImageEmbedding(jobSettings.imageEmbedding);
    job.outputPath = await this.outputPathFor(job.inputPath, job, jobSettings);
    resetEstimate(job);
    for (const image of previousImages) void this.releaseImageIfUnused(image);
  }

  private drawImage(slot: ImageSlot, assets: ImageAsset[]) {
    if (!assets.length) {
      this.imagePool[slot] = [];
      this.knownPoolImages[slot].clear();
      return null;
    }
    const currentIds = new Set(assets.map(asset => asset.id));
    this.imagePool[slot] = this.imagePool[slot].filter(id => currentIds.has(id));
    for (const asset of assets) {
      if (!this.knownPoolImages[slot].has(asset.id)) this.imagePool[slot].push(asset.id);
    }
    this.knownPoolImages[slot] = currentIds;
    if (!this.imagePool[slot].length) {
      this.imagePool[slot] = assets.map(asset => asset.id);
    }
    const index =
      this.imagePool[slot].length === 1
        ? 0
        : Math.floor(
            Math.min(0.999999999, Math.max(0, this.random())) * this.imagePool[slot].length
          );
    const [id] = this.imagePool[slot].splice(index, 1);
    const selected = assets.find(asset => asset.id === id) ?? assets[0];
    return { ...selected };
  }

  private async outputPathFor(
    inputPath: string,
    current?: CompressionJob,
    settings: AgentSettings = this.settings,
    extraReserved: string[] = []
  ) {
    let folder: string | undefined;
    if (settings.outputMode === 'chosen-folder') {
      folder = settings.outputFolder ?? undefined;
      if (!folder) throw new Error('Choose an output folder first.');
    }
    if (folder) await mkdir(folder, { recursive: true });
    const reserved = this.jobs
      .filter(job => job !== current)
      .map(job => job.outputPath)
      .filter(Boolean)
      .concat(extraReserved.filter(Boolean));
    return nextOutputPath(
      inputPath,
      folder,
      reserved,
      Boolean(draftImageEmbedding(settings.imageEmbedding))
    );
  }

  private async diskWarning(jobs: CompressionJob[]) {
    if (!jobs.length) return null;
    const byFolder = new Map<string, number>();
    for (const job of jobs) {
      const folder = path.dirname(job.outputPath);
      const expected = Math.max(job.originalSize, job.estimatedOutputBytes ?? 0);
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + expected);
    }
    for (const [folder, required] of byFolder) {
      try {
        const info = await statfs(folder);
        const free = info.bavail * info.bsize;
        if (free < required * 1.1) {
          return `Free space may be insufficient in ${folder}. Compression will continue, but consider freeing disk space.`;
        }
      } catch {
        return `Could not check free space in ${folder}.`;
      }
    }
    return null;
  }

  /** True while the current batch still has work nobody has picked up. */
  private queuedInBatch(): boolean {
    return Boolean(
      this.batch && this.jobs.some(job => job.batchId === this.batch!.id && job.status === 'queued')
    );
  }

  /**
   * Watches for a drain loop that was dropped — by a rejected handoff, a tool
   * outage, or a team job left behind — and re-drives it.
   *
   * A queued job with nothing in flight used to keep `running` (and therefore
   * the whole compressor UI) wedged until the agent restarted. The check lived
   * in `state()` for a while, which read cheaply but meant every SSE broadcast
   * could schedule a pump, and a pump that notified on a bail-out path would
   * have looped `state → pump → notify → state` through microtasks with no turn
   * of the event loop in between. A recovery mechanism should not be able to
   * hang the process it is recovering, so it runs on its own slow timer.
   */
  private startDrainWatchdog() {
    if (this.drainWatchdog) return;
    const timer = setInterval(() => {
      if (!this.batch || this.batch.finishedAt) {
        this.stopDrainWatchdog();
        return;
      }
      if (this.compressionInFlight || this.prioritizingEstimates) return;
      if (this.queuedInBatch()) {
        void this.pump();
        return;
      }
      // A batch with nothing queued and nothing in flight is over, whatever
      // ended it. Closing it here is what lets this timer retire: a safety net
      // that cannot stop looking is itself a leak.
      this.closeBatchIfDrained();
      this.notify();
    }, DRAIN_WATCHDOG_MS);
    // Never hold the process open for a safety net.
    timer.unref();
    this.drainWatchdog = timer;
  }

  private stopDrainWatchdog() {
    if (!this.drainWatchdog) return;
    clearInterval(this.drainWatchdog);
    this.drainWatchdog = null;
  }

  /**
   * Marks the batch finished once nothing is left to do.
   *
   * `pump()` does this on its way out of a normal drain, but it also bails
   * early when a media tool is missing — and a batch the user stopped has to
   * close either way, or the queue keeps reporting a batch that will never
   * finish.
   */
  private closeBatchIfDrained() {
    if (!this.batch || this.batch.finishedAt) return;
    if (this.compressionInFlight || this.prioritizingEstimates || this.queuedInBatch()) return;
    this.batch.finishedAt = Date.now();
    this.stopDrainWatchdog();
  }

  private async pump() {
    if (
      this.compressionInFlight ||
      this.prioritizingEstimates ||
      !this.batch ||
      !this.tools.ffmpeg ||
      !this.tools.ffprobe
    )
      return;
    const job = this.jobs.find(
      candidate => candidate.batchId === this.batch!.id && candidate.status === 'queued'
    );
    if (!job) {
      if (!this.batch.finishedAt) this.batch.finishedAt = Date.now();
      this.stopDrainWatchdog();
      if (this.updateState.state === 'draining') this.updateState.state = 'pending';
      this.notify();
      this.estimateHooks?.resume();
      return;
    }

    // Set the in-flight flag and the abort handle as the very first statements
    // inside the guarded region so a throw from `notify()` (or anywhere below)
    // can never strand `compressionInFlight=true` — which would wedge the queue
    // as permanently "running" until the agent restarts.
    const abort = new AbortController();
    try {
      this.compressionInFlight = true;
      this.activeAbort = abort;
      job.status = 'processing';
      job.error = null;
      job.errorDetails = null;
      job.estimatePriorityOrder = null;
      job.startedAt = Date.now();
      job.finishedAt = null;
      job.processingStage = job.imageEmbedding ? 'preparing-images' : 'compressing';
      this.notify();
      await access(job.inputPath);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      const embedding = await this.embeddingOptions(job, abort.signal);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      job.processingStage = 'compressing';
      this.notify();
      let result = await this.run(job, false, embedding);
      if (result.spawnErrorCode) {
        throw new MediaToolUnavailableError('ffmpeg', result.spawnErrorCode);
      }
      if (
        !embedding &&
        !isCancelled(job) &&
        result.code !== 0 &&
        isAudioCopyFailure(result.stderr)
      ) {
        await unlink(job.outputPath).catch(() => {});
        job.progress = job.durationSeconds ? 0 : null;
        this.notify();
        result = await this.run(job, true, embedding);
        if (result.spawnErrorCode) {
          throw new MediaToolUnavailableError('ffmpeg', result.spawnErrorCode);
        }
      }
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
      } else if (result.code === 0) {
        job.processingStage = 'finalizing';
        this.notify();
        const media = await this.mediaRuntime.probeMedia(job.outputPath);
        await this.completeJob(job, media);
      } else {
        job.status = 'failed';
        job.error = friendlyError(result.stderr);
        job.errorDetails = result.stderr || null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
        await unlink(job.outputPath).catch(() => {});
      }
    } catch (error) {
      // A cancel during `preparing-images` aborts background media work, which
      // surfaces here as a rejection. The job is already marked `cancelled`, so
      // treat it as a clean cancellation rather than overwriting it with a
      // failure state.
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      if (isMediaToolUnavailableError(error)) {
        const phase = job.processingStage === 'finalizing' ? 'output-validation' : 'encoding';
        await this.pauseForRuntimeFailure(job, error, phase);
        return;
      }
      job.status = 'failed';
      job.error = processingError(error);
      job.errorDetails = error instanceof Error ? error.message : null;
      job.processingStage = null;
      job.finishedAt = finishTimestamp(job);
      await unlink(job.outputPath).catch(() => {});
    } finally {
      if (this.activeAbort === abort) this.activeAbort = null;
      this.active = null;
      this.compressionInFlight = false;
      this.compressionPausedForEstimates = false;
      // Queue the next drain first: a throw from `notify` or from the estimate
      // handoff below must never drop the loop and leave the rest of the batch
      // queued forever. `pump` bails on its own if either takes the queue over.
      queueMicrotask(() => void this.pump());
      this.notify();
      await this.runPrioritizedEstimates();
    }
  }

  private async completeJob(job: CompressionJob, media: MediaInfo) {
    validateCompletedOutput(job, media);
    job.status = 'completed';
    job.progress = 100;
    job.processingStage = null;
    job.finalSize = await fileSize(job.outputPath);
    job.finalWidth = media.width;
    job.finalHeight = media.height;
    job.finalFrameRate = media.frameRate;
    job.finalBitrate = media.bitrate;
    job.finalDurationSeconds = media.duration;
    job.finalCodec = media.codec;
    job.error = null;
    job.errorDetails = null;
    job.estimateStatus = 'cancelled';
    job.estimateProgress = null;
    job.finishedAt = finishTimestamp(job);
  }

  private async pauseForRuntimeFailure(
    job: CompressionJob,
    error: MediaToolUnavailableError,
    phase: RuntimeRecoveryPhase
  ) {
    this.tools[error.tool] = false;
    this.warning = RUNTIME_WARNING;
    job.status = phase === 'input-analysis' ? 'analyzing' : 'interrupted';
    job.error = RUNTIME_JOB_ERROR;
    job.errorDetails = runtimeRecoveryDetails(error, phase);
    job.processingStage = null;
    job.finishedAt = phase === 'input-analysis' ? null : finishTimestamp(job);
    if (phase === 'output-validation') {
      job.progress = 100;
      job.finalSize = await fileSize(job.outputPath).catch(() => null);
    } else if (phase === 'encoding') {
      await unlink(job.outputPath).catch(() => {});
    }

    if (this.batch) {
      for (const queued of this.jobs) {
        if (queued.batchId !== this.batch.id || queued.status !== 'queued') continue;
        queued.status = 'ready';
        queued.batchId = null;
        queued.processingStage = null;
        queued.estimatePriorityOrder = null;
      }
      this.batch.finishedAt ??= Date.now();
      this.stopDrainWatchdog();
    }
    this.notify();
    try {
      this.runtimeRecovery?.(error);
    } catch {
      // The persisted recovery marker is sufficient for a later manual launch.
    }
  }

  private async embeddingOptions(job: CompressionJob, signal?: AbortSignal) {
    if (!job.imageEmbedding) return undefined;
    const dimensions = outputDimensions(job);
    if (!dimensions || !job.durationSeconds) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: output dimensions or duration are unavailable.');
    }
    if (job.encoding.frameRate === null && !job.sourceFrameRate) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: original frame rate is unavailable.');
    }
    const frameRate = outputFrameRate(job);
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: output frame rate is unavailable.');
    }
    if (job.imageEmbedding.replaceExisting) {
      const trims = await detectStaticEdgeTrims(
        job.inputPath,
        job.durationSeconds,
        job.sourceFrameRate ?? frameRate,
        signal
      );
      job.imageEmbedding.sourceTrimStartSeconds = trims.startSeconds;
      job.imageEmbedding.sourceTrimEndSeconds = trims.endSeconds;
      if (!refreshEstimateFromBreakdown(job)) resetEstimate(job);
      this.notify();
    }
    const sourceDuration = sourceDurationSeconds(job);
    if (sourceDuration <= 0) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: no moving source frames remain.');
    }
    const startImagePath = job.imageEmbedding.startImage
      ? await this.imageStore.validate(job.imageEmbedding.startImage)
      : null;
    const endImagePath = job.imageEmbedding.endImage
      ? await this.imageStore.validate(job.imageEmbedding.endImage)
      : null;
    if (job.imageEmbedding.endImage && !job.imageEmbedding.finalDurationSeconds) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: final image duration is invalid.');
    }
    return {
      sourceStartSeconds: job.imageEmbedding.sourceTrimStartSeconds,
      sourceDurationSeconds: sourceDuration,
      sourceHasAudio: job.sourceHasAudio,
      width: dimensions.width,
      height: dimensions.height,
      frameRate,
      imageEmbedding: cloneJobImageEmbedding(job.imageEmbedding)!,
      startImagePath,
      endImagePath
    };
  }

  private hasPrioritizedEstimate() {
    return this.jobs.some(
      candidate =>
        candidate.status === 'queued' &&
        candidate.estimateStatus === 'waiting' &&
        candidate.estimatePriorityOrder !== null
    );
  }

  private async runPrioritizedEstimates() {
    const runPrioritized = this.estimateHooks?.runPrioritized;
    if (
      !runPrioritized ||
      this.prioritizingEstimates ||
      !this.batch ||
      !this.hasPrioritizedEstimate()
    ) {
      return;
    }
    if (this.compressionInFlight && !this.active) return;
    const pausedChild = this.active;
    // Claim the flag before any awaited/notifying work so the `finally` below
    // always resets it; a throw here must never strand `prioritizingEstimates`
    // (which would wedge `running=true`) or leave `pausedChild` suspended.
    this.prioritizingEstimates = true;
    try {
      if (pausedChild) {
        if (this.holdForEstimates(pausedChild)) {
          this.compressionPausedForEstimates = true;
        } else if (this.pauseSupported()) {
          // The pause signal could not be delivered (the process is likely
          // already gone); leave the handoff to the next scheduling pass.
          return;
        }
        // Platforms without pause support (Windows) fall through: prioritized
        // estimates simply run alongside the active compression.
      }
      this.notify();
      let processed: boolean;
      do {
        processed = await runPrioritized();
      } while (
        processed &&
        this.hasPrioritizedEstimate() &&
        (!this.compressionActive() || !this.pauseSupported())
      );
    } catch {
      // A failed handoff must never leave the compression process suspended.
    } finally {
      if (pausedChild && this.active === pausedChild) this.releaseEstimateHold();
      this.compressionPausedForEstimates = false;
      this.prioritizingEstimates = false;
      if (!this.compressionInFlight) queueMicrotask(() => void this.pump());
      this.notify();
    }
  }

  private run(
    job: CompressionJob,
    fallback: boolean,
    embedding: EncodeEmbeddingOptions | undefined
  ) {
    if (job.startedAt === null) {
      job.startedAt = Date.now();
      this.notify();
    }
    const operation = encodeVideo(
      job.inputPath,
      job.outputPath,
      outputDurationSeconds(job),
      job.encoding,
      fallback,
      value => {
        job.progress = value;
        this.notify();
      },
      embedding
    );
    this.active = operation.child;
    void this.runPrioritizedEstimates();
    return operation.done;
  }
}

function cloneJob(job: CompressionJob): CompressionJob {
  return {
    ...job,
    encoding: { ...job.encoding },
    imageEmbedding: cloneJobImageEmbedding(job.imageEmbedding),
    estimateProgress: job.estimateProgress ? { ...job.estimateProgress } : null,
    estimateBreakdown: job.estimateBreakdown ? { ...job.estimateBreakdown } : null
  };
}

function jobImages(job: CompressionJob) {
  return [job.imageEmbedding?.startImage ?? null, job.imageEmbedding?.endImage ?? null].filter(
    (image): image is ImageAsset => Boolean(image)
  );
}

function resetEstimate(job: CompressionJob) {
  job.estimateStatus = 'waiting';
  job.estimatedOutputBytes = null;
  job.estimatedSavingPercent = null;
  job.estimateRangeMinBytes = null;
  job.estimateRangeMaxBytes = null;
  job.estimateProgress = null;
  job.estimateError = null;
  job.estimateKey = null;
  job.estimatePriorityOrder = null;
  job.estimateBreakdown = null;
}

function friendlyError(stderr: string) {
  if (/no space left on device/i.test(stderr)) return 'There is not enough free disk space.';
  if (/permission denied|read-only file system/i.test(stderr)) {
    return 'The destination folder is not writable.';
  }
  if (/invalid data found|could not find codec parameters/i.test(stderr)) {
    return 'This video format is not supported or the file is damaged.';
  }
  if (
    /concat input.*parameters do not match|failed to configure output pad|pixel format/i.test(
      stderr
    )
  ) {
    return 'The images could not be adapted to this video.';
  }
  if (/error initializing complex filters|invalid argument/i.test(stderr)) {
    return 'The image filter graph could not be created.';
  }
  return 'FFmpeg could not compress this video.';
}

function validSourceMedia(media: MediaInfo) {
  return Boolean(media.width && media.height && media.duration);
}

function applySourceMedia(job: CompressionJob, media: MediaInfo) {
  job.durationSeconds = media.duration;
  job.sourceWidth = media.width;
  job.sourceHeight = media.height;
  job.sourceFrameRate = media.frameRate;
  job.sourceBitrate = media.bitrate;
  job.sourceCodec = media.codec;
  job.sourceHasAudio = media.hasAudio;
  job.sourceAudioBitrate = media.audioBitrate;
  job.sourceAudioSampleRate = media.audioSampleRate;
  job.sourceAudioChannels = media.audioChannels;
  job.sourceAudioLayout = media.audioLayout;
  job.progress = 0;
}

function runtimeRecoveryDetails(error: MediaToolUnavailableError, phase: RuntimeRecoveryPhase) {
  return JSON.stringify({
    code: error.code,
    phase,
    tool: error.tool,
    causeCode: error.causeCode
  });
}

function parseRuntimeRecovery(value: string | null): {
  phase: RuntimeRecoveryPhase;
  tool: MediaToolName;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const phase = parsed.phase;
    const tool = parsed.tool;
    if (
      parsed.code === 'MEDIA_TOOL_UNAVAILABLE' &&
      (phase === 'input-analysis' || phase === 'encoding' || phase === 'output-validation') &&
      (tool === 'ffmpeg' || tool === 'ffprobe')
    ) {
      return { phase, tool };
    }
  } catch {
    // Older free-text errors are not automatic recovery markers.
  }
  return null;
}

function processingError(error: unknown) {
  if (error instanceof ImageAssetError) {
    return error.code === 'IMAGE_DAMAGED'
      ? 'An image is damaged or could not be decoded.'
      : 'An image is no longer available to the local agent.';
  }
  if (error instanceof OutputValidationError) {
    return 'The completed file did not pass FFprobe validation.';
  }
  if (error instanceof Error && /IMAGE_FILTER_GRAPH_INVALID/.test(error.message)) {
    return 'The image filter graph could not be created.';
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return 'The source file is no longer available.';
  }
  return 'The file could not be processed.';
}

class OutputValidationError extends Error {}

function validateCompletedOutput(job: CompressionJob, media: MediaInfo) {
  const errors: string[] = [];
  if (!media.formatName || !/(?:^|,)mp4(?:,|$)|(?:^|,)mov(?:,|$)/.test(media.formatName)) {
    errors.push(`format=${media.formatName ?? 'missing'}`);
  }
  if (!media.width || !media.height) errors.push('dimensions=missing');
  if (!media.duration) errors.push('duration=missing');
  if (!media.codec) errors.push('codec=missing');
  if (errors.length) throw new OutputValidationError(errors.join('; '));
  if (job.imageEmbedding) validateEmbeddedOutput(job, media);
}

function validateEmbeddedOutput(job: CompressionJob, media: MediaInfo) {
  const dimensions = outputDimensions(job);
  const frameRate = outputFrameRate(job);
  const duration = outputDurationSeconds(job);
  const errors: string[] = [];
  if (!media.formatName || !/(?:^|,)mp4(?:,|$)|(?:^|,)mov(?:,|$)/.test(media.formatName)) {
    errors.push(`format=${media.formatName ?? 'missing'}`);
  }
  if (!dimensions || media.width !== dimensions.width || media.height !== dimensions.height) {
    errors.push(
      `dimensions=${media.width ?? 'missing'}x${media.height ?? 'missing'}, expected=${dimensions?.width ?? 'missing'}x${dimensions?.height ?? 'missing'}`
    );
  }
  if (
    !media.frameRate ||
    Math.abs(media.frameRate - frameRate) > Math.max(0.03, frameRate * 0.001)
  ) {
    errors.push(`fps=${media.frameRate ?? 'missing'}, expected=${frameRate}`);
  }
  const durationTolerance = Math.max(0.2, 2 / frameRate);
  if (!media.duration || Math.abs(media.duration - duration) > durationTolerance) {
    errors.push(`duration=${media.duration ?? 'missing'}, expected=${duration}`);
  }
  if (!media.hasAudio) errors.push('audio=missing');
  if (
    media.audioDuration &&
    media.videoDuration &&
    Math.abs(media.audioDuration - media.videoDuration) > durationTolerance
  ) {
    errors.push(`audio/video duration mismatch=${media.audioDuration}/${media.videoDuration}`);
  }
  if (errors.length) throw new OutputValidationError(errors.join('; '));
}

function isCancelled(job: CompressionJob) {
  return job.status === 'cancelled';
}

function finishTimestamp(job: CompressionJob) {
  return Math.max(Date.now(), job.startedAt ?? 0);
}

async function cleanupImportedSource(job: CompressionJob) {
  if (job.sourceKind !== 'uploaded') return;
  await unlink(job.inputPath).catch(() => {});
}

export function jobEstimateIsCurrent(job: CompressionJob) {
  return (
    job.estimateStatus === 'estimated' &&
    job.estimateKey === jobConfigurationKey(job.encoding, job.imageEmbedding)
  );
}

function cloneSettings(settings: AgentSettings): AgentSettings {
  return { ...settings, imageEmbedding: cloneImageEmbeddingSettings(settings.imageEmbedding) };
}

function cloneImageEmbeddingSettings(settings: AgentSettings['imageEmbedding']) {
  return {
    ...settings,
    startImages: settings.startImages.map(asset => ({ ...asset })),
    endImages: settings.endImages.map(asset => ({ ...asset }))
  };
}

function cloneJobImageEmbedding(settings: CompressionJob['imageEmbedding']) {
  return settings
    ? {
        ...settings,
        startImage: settings.startImage ? { ...settings.startImage } : null,
        endImage: settings.endImage ? { ...settings.endImage } : null
      }
    : null;
}

function imageEmbeddingSettingsKey(settings: AgentSettings['imageEmbedding']) {
  return JSON.stringify([
    settings.enabled,
    settings.startImages.map(asset => asset.id),
    settings.endImages.map(asset => asset.id),
    settings.replaceExisting,
    settings.finalDurationMode,
    settings.customFinalDurationSeconds,
    settings.startDurationMode,
    settings.customStartDurationMs,
    settings.fitMode
  ]);
}
