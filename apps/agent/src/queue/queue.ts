import { randomUUID } from 'node:crypto';
import { access, mkdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
  type QueueBatch,
  type QueueState,
  type SelectionWarning,
  type SourceKind
} from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure, type EncodeEmbeddingOptions } from '../ffmpeg/encoder.js';
import { probeMedia, type MediaInfo } from '../ffmpeg/tools.js';
import { fileSize, nextOutputPath } from '../files/paths.js';
import {
  freezeImageEmbedding,
  outputDimensions,
  outputDurationSeconds,
  outputFrameRate,
  refreshEstimateFromBreakdown
} from '../images/embedding.js';
import { ImageAssetError, ImageAssetStore } from '../images/store.js';
import { defaultSettings } from './store.js';

type EstimatorHooks = {
  schedule: () => void;
  invalidate: () => void;
  resume: () => void;
  runPrioritized?: () => Promise<boolean>;
  cancelPrioritized?: (id: string) => void;
};

export interface AddSourceOptions {
  sourceKind?: SourceKind;
  sourceKey?: string | null;
  fileName?: string;
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
  private compressionInFlight = false;
  private compressionPausedForEstimates = false;
  private prioritizingEstimates = false;
  private nextEstimatePriorityOrder = 1;
  private warning: string | null = null;
  private estimateHooks: EstimatorHooks | null = null;

  constructor(
    private tools: QueueState['tools'],
    private notify: (event?: AgentEventType) => void,
    private jobs: CompressionJob[] = [],
    private settings: AgentSettings = defaultSettings,
    private batch: QueueBatch | null = null,
    private imageStore = new ImageAssetStore(),
    private random = Math.random
  ) {
    this.nextEstimatePriorityOrder =
      Math.max(0, ...jobs.map(job => job.estimatePriorityOrder ?? 0)) + 1;
  }

  attachEstimator(hooks: EstimatorHooks) {
    this.estimateHooks = hooks;
  }

  state(): QueueState {
    const running =
      this.compressionInFlight ||
      this.prioritizingEstimates ||
      Boolean(
        this.batch &&
        this.jobs.some(job => job.batchId === this.batch!.id && job.status === 'queued')
      );
    return {
      jobs: this.jobs.map(job => cloneJob(job)),
      running,
      tools: this.tools,
      settings: cloneSettings(this.settings),
      batch: this.batch ? { ...this.batch, jobIds: [...this.batch.jobIds] } : null,
      warning: this.warning
    };
  }

  compressionActive() {
    return this.compressionInFlight && !this.compressionPausedForEstimates;
  }

  persisted() {
    return {
      jobs: this.jobs.map(job => cloneJob(job)),
      settings: cloneSettings(this.settings),
      batch: this.batch ? { ...this.batch, jobIds: [...this.batch.jobIds] } : null
    };
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
      ['mode', 'frameRate', 'resolutionLimit', 'rateControl', 'crf', 'videoBitrateKbps'] as const
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
        if (!['analyzing', 'ready', 'failed', 'cancelled', 'interrupted'].includes(job.status))
          continue;
        job.outputPath = await this.outputPathFor(job.inputPath, job.sourceKind ?? 'local', job);
      }
    }
    this.notify();
  }

  async setImage(slot: ImageSlot, asset: ImageAsset | null) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    if (slot === 'start') imageEmbedding.startImage = asset ? { ...asset } : null;
    else imageEmbedding.endImage = asset ? { ...asset } : null;
    await this.updateSettings({ imageEmbedding });
  }

  imageAsset(id: string) {
    const settingsAssets = [
      this.settings.imageEmbedding.startImage,
      this.settings.imageEmbedding.endImage
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
    for (const slot of ['startImage', 'endImage'] as const) {
      const asset = imageEmbedding[slot];
      if (asset) {
        try {
          await this.imageStore.validate(asset);
        } catch {
          imageEmbedding[slot] = null;
          changed = true;
        }
      }
    }
    if (changed) await this.updateSettings({ imageEmbedding });
    return changed;
  }

  embeddingConfigurationError() {
    const embedding = this.settings.imageEmbedding;
    if (embedding.enabled && !embedding.startImage && !embedding.endImage) {
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

  async start(ids: string[]) {
    if (this.state().running || this.embeddingConfigurationError()) return false;
    const requested = new Set(ids);
    const jobs = this.jobs.filter(job => requested.has(job.id) && job.status === 'ready');
    if (!jobs.length) return false;

    const batch: QueueBatch = {
      id: randomUUID(),
      jobIds: jobs.map(job => job.id),
      startedAt: Date.now(),
      finishedAt: null
    };
    this.batch = batch;
    this.warning = await this.diskWarning(jobs);
    for (const job of jobs) {
      const draftKey = jobConfigurationKey(job.encoding, job.imageEmbedding);
      job.imageEmbedding = freezeImageEmbedding(this.settings.imageEmbedding, this.random);
      job.outputPath = await this.outputPathFor(job.inputPath, job.sourceKind ?? 'local', job);
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
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== 'processing') return false;
    job.status = 'cancelled';
    job.error = 'Compression was cancelled.';
    job.finishedAt = finishTimestamp(job);
    job.processingStage = null;
    resetEstimate(job);
    if (this.compressionPausedForEstimates) this.active?.kill('SIGCONT');
    this.active?.kill('SIGTERM');
    this.notify('estimate:queued');
    return true;
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
    void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
    return true;
  }

  removeMany(ids: string[]) {
    const selected = new Set(ids);
    const removable = this.jobs.filter(
      job => selected.has(job.id) && !['processing', 'queued'].includes(job.status)
    );
    if (!removable.length) return 0;
    for (const job of removable) {
      if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(job.id);
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
    job.encoding = encodingFromSettings(this.settings);
    job.imageEmbedding = draftImageEmbedding(this.settings.imageEmbedding);
    job.outputPath = await this.outputPathFor(job.inputPath, job.sourceKind ?? 'local', job);
    resetEstimate(job);
    for (const image of previousImages) void this.releaseImageIfUnused(image);
    this.notify('estimate:queued');
    this.estimateHooks?.schedule();
    return true;
  }

  clearCompleted() {
    const removed = this.jobs.filter(job =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
    );
    const images = removed.flatMap(jobImages);
    this.jobs = this.jobs.filter(job => !removed.includes(job));
    for (const job of removed) void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
  }

  outputFolder(): string | null {
    const completed = this.jobs.find(job => job.status === 'completed');
    return completed ? path.dirname(completed.outputPath) : this.settings.outputFolder;
  }

  async shutdown() {
    const child = this.active;
    if (!child) return;
    if (this.compressionPausedForEstimates) child.kill('SIGCONT');
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolve => child.once('close', () => resolve())),
      new Promise<void>(resolve =>
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000)
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
    return this.jobs.map(job => cloneJob(job));
  }

  private async addOne(
    inputPath: string,
    options: AddSourceOptions,
    allowWarnings: boolean
  ): Promise<SelectionWarning | null> {
    const canonical = path.resolve(inputPath);
    const fileName = options.fileName ?? path.basename(canonical);
    if (!isSupportedVideoPath(fileName)) {
      return issue(fileName, 'unsupported-format', 'This file format is not supported.');
    }

    // Re-adding a file that is already in the list is still rejected, but a
    // video that merely looks already-compressed can be re-compressed freely.
    const duplicate = this.jobs.some(job =>
      options.sourceKey
        ? job.sourceKey === options.sourceKey
        : path.resolve(job.inputPath) === canonical
    );
    if (duplicate && !allowWarnings) {
      return issue(fileName, 'duplicate', 'This video is already in the list.');
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
        encoding: encodingFromSettings(this.settings),
        imageEmbedding: draftImageEmbedding(this.settings.imageEmbedding),
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
      job.outputPath = await this.outputPathFor(canonical, sourceKind, job);
      this.jobs.push(job);
      this.notify();

      if (!this.tools.ffprobe) {
        job.status = 'failed';
        job.error = 'The video analysis engine is unavailable.';
        this.notify();
        return null;
      }
      const media = await probeMedia(canonical);
      if (!media.width || !media.height || !media.duration) {
        job.status = 'failed';
        job.error = 'This video format is not supported or the file is damaged.';
        this.notify();
        return null;
      }
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
      job.status = 'ready';
      this.notify('estimate:queued');
      this.estimateHooks?.schedule();
      return null;
    } catch {
      return issue(fileName, 'inaccessible', 'The file is no longer accessible.');
    }
  }

  private async outputPathFor(inputPath: string, sourceKind: SourceKind, current?: CompressionJob) {
    let folder: string | undefined;
    if (this.settings.outputMode === 'chosen-folder') {
      folder = this.settings.outputFolder ?? undefined;
      if (!folder) throw new Error('Choose an output folder first.');
    } else if (sourceKind === 'uploaded') {
      folder = uploadedOutputFolder();
    }
    if (folder) await mkdir(folder, { recursive: true });
    const reserved = this.jobs
      .filter(job => job !== current)
      .map(job => job.outputPath)
      .filter(Boolean);
    return nextOutputPath(
      inputPath,
      folder,
      reserved,
      Boolean(draftImageEmbedding(this.settings.imageEmbedding))
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

  private async pump() {
    if (this.compressionInFlight || this.prioritizingEstimates || !this.batch) return;
    const job = this.jobs.find(
      candidate => candidate.batchId === this.batch!.id && candidate.status === 'queued'
    );
    if (!job) {
      if (!this.batch.finishedAt) this.batch.finishedAt = Date.now();
      this.notify();
      this.estimateHooks?.resume();
      return;
    }

    this.compressionInFlight = true;
    job.status = 'processing';
    job.error = null;
    job.errorDetails = null;
    job.estimatePriorityOrder = null;
    job.startedAt = Date.now();
    job.finishedAt = null;
    job.processingStage = job.imageEmbedding ? 'preparing-images' : 'compressing';
    this.notify();
    try {
      await access(job.inputPath);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      const embedding = await this.embeddingOptions(job);
      job.processingStage = 'compressing';
      this.notify();
      let result = await this.run(job, false, embedding);
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
      }
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
      } else if (result.code === 0) {
        job.processingStage = 'finalizing';
        this.notify();
        const media = await probeMedia(job.outputPath);
        if (job.imageEmbedding) validateEmbeddedOutput(job, media);
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
        job.estimateStatus = 'cancelled';
        job.estimateProgress = null;
        job.finishedAt = finishTimestamp(job);
        await cleanupImportedSource(job);
      } else {
        job.status = 'failed';
        job.error = friendlyError(result.stderr);
        job.errorDetails = result.stderr || null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
        await unlink(job.outputPath).catch(() => {});
      }
    } catch (error) {
      job.status = 'failed';
      job.error = processingError(error);
      job.errorDetails = error instanceof Error ? error.message : null;
      job.processingStage = null;
      job.finishedAt = finishTimestamp(job);
      await unlink(job.outputPath).catch(() => {});
    } finally {
      this.active = null;
      this.compressionInFlight = false;
      this.compressionPausedForEstimates = false;
      this.notify();
      await this.runPrioritizedEstimates();
      queueMicrotask(() => void this.pump());
    }
  }

  private async embeddingOptions(job: CompressionJob) {
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
      sourceDurationSeconds: job.durationSeconds,
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
    if (pausedChild) {
      try {
        if (!pausedChild.kill('SIGSTOP')) return;
      } catch {
        return;
      }
      this.compressionPausedForEstimates = true;
    }
    this.prioritizingEstimates = true;
    this.notify();
    try {
      let processed: boolean;
      do {
        processed = await runPrioritized();
      } while (processed && this.hasPrioritizedEstimate() && !this.compressionActive());
    } catch {
      // A failed handoff must never leave the compression process suspended.
    } finally {
      if (pausedChild && this.active === pausedChild) pausedChild.kill('SIGCONT');
      this.compressionPausedForEstimates = false;
      this.prioritizingEstimates = false;
      this.notify();
      if (!this.compressionInFlight) queueMicrotask(() => void this.pump());
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

function issue(
  fileName: string,
  reason: SelectionWarning['reason'],
  message: string
): SelectionWarning {
  return { id: randomUUID(), fileName, reason, message };
}

function uploadedOutputFolder() {
  const videosFolder = process.platform === 'darwin' ? 'Movies' : 'Videos';
  return path.join(os.homedir(), videosFolder, 'Wishly');
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
    startImage: settings.startImage ? { ...settings.startImage } : null,
    endImage: settings.endImage ? { ...settings.endImage } : null
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
    settings.startImage?.id ?? null,
    settings.endImage?.id ?? null,
    settings.finalDurationMode,
    settings.customFinalDurationSeconds,
    settings.fitMode
  ]);
}
