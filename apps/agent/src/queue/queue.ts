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
  encodingFromSettings,
  encodingKey,
  type AgentEventType,
  type AgentSettings,
  type CompressionJob,
  type QueueBatch,
  type QueueState,
  type SelectionWarning,
  type SourceKind
} from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure } from '../ffmpeg/encoder.js';
import { probeMedia } from '../ffmpeg/tools.js';
import { appearsCompressed, fileSize, nextOutputPath } from '../files/paths.js';
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
    private batch: QueueBatch | null = null
  ) {
    this.nextEstimatePriorityOrder = Math.max(0, ...jobs.map(job => job.estimatePriorityOrder ?? 0)) + 1;
  }

  attachEstimator(hooks: EstimatorHooks) {
    this.estimateHooks = hooks;
  }

  state(): QueueState {
    const running =
      this.compressionInFlight ||
      this.prioritizingEstimates ||
      Boolean(this.batch && this.jobs.some(job => job.batchId === this.batch!.id && job.status === 'queued'));
    return {
      jobs: this.jobs.map(job => cloneJob(job)),
      running,
      tools: this.tools,
      settings: { ...this.settings },
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
      settings: { ...this.settings },
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

    const encodingChanged = (
      ['mode', 'frameRate', 'resolutionLimit', 'rateControl', 'crf', 'videoBitrateKbps'] as const
    ).some(key => normalized[key] !== undefined && normalized[key] !== this.settings[key]);
    const outputChanged = (
      ['outputMode', 'outputFolder'] as const
    ).some(key => normalized[key] !== undefined && normalized[key] !== this.settings[key]);
    this.settings = { ...this.settings, ...normalized };

    if (encodingChanged) {
      const encoding = encodingFromSettings(this.settings);
      for (const job of this.jobs) {
        if (!['analyzing', 'ready', 'failed', 'cancelled', 'interrupted'].includes(job.status)) continue;
        job.encoding = { ...encoding };
        resetEstimate(job);
      }
      this.estimateHooks?.invalidate();
    }

    if (outputChanged) {
      for (const job of this.jobs) {
        if (!['analyzing', 'ready', 'failed', 'cancelled', 'interrupted'].includes(job.status)) continue;
        job.outputPath = await this.outputPathFor(job.inputPath, job.sourceKind ?? 'local', job);
      }
    }
    this.notify();
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
    if (this.state().running) return false;
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
      job.status = 'queued';
      job.batchId = batch.id;
      job.error = null;
      job.errorDetails = null;
      job.progress = job.durationSeconds ? 0 : null;
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
    this.jobs = this.jobs.filter(candidate => candidate !== job);
    void cleanupImportedSource(job);
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
    this.jobs = this.jobs.filter(job => !removed.has(job.id));
    for (const job of removable) void cleanupImportedSource(job);
    this.notify();
    return removable.length;
  }

  async retry(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status)) return false;
    job.status = 'ready';
    job.error = null;
    job.errorDetails = null;
    job.progress = job.durationSeconds ? 0 : null;
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
    job.outputPath = await this.outputPathFor(job.inputPath, job.sourceKind ?? 'local', job);
    resetEstimate(job);
    this.notify('estimate:queued');
    this.estimateHooks?.schedule();
    return true;
  }

  clearCompleted() {
    const removed = this.jobs.filter(job =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
    );
    this.jobs = this.jobs.filter(job => !removed.includes(job));
    for (const job of removed) void cleanupImportedSource(job);
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

    const duplicate = this.jobs.some(job =>
      options.sourceKey
        ? job.sourceKey === options.sourceKey
        : path.resolve(job.inputPath) === canonical
    );
    const reason = duplicate ? 'duplicate' : appearsCompressed(fileName) ? 'already-compressed' : null;
    if (reason && !allowWarnings) {
      return issue(
        fileName,
        reason,
        reason === 'duplicate'
          ? 'This video is already in the list.'
          : 'This video appears to be already compressed.'
      );
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
        finalSize: null,
        finalWidth: null,
        finalHeight: null,
        finalFrameRate: null,
        finalBitrate: null,
        finalDurationSeconds: null,
        finalCodec: null,
        progress: null,
        status: 'analyzing',
        error: null,
        errorDetails: null,
        encoding: encodingFromSettings(this.settings),
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
        estimatePriorityOrder: null
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
    return nextOutputPath(inputPath, folder, reserved);
  }

  private async diskWarning(jobs: CompressionJob[]) {
    if (!jobs.length) return null;
    const byFolder = new Map<string, number>();
    for (const job of jobs) {
      const folder = path.dirname(job.outputPath);
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + job.originalSize);
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
    job.startedAt = null;
    job.finishedAt = null;
    this.notify();
    try {
      await access(job.inputPath);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      let result = await this.run(job, false);
      if (!isCancelled(job) && result.code !== 0 && isAudioCopyFailure(result.stderr)) {
        await unlink(job.outputPath).catch(() => {});
        job.progress = job.durationSeconds ? 0 : null;
        this.notify();
        result = await this.run(job, true);
      }
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
      } else if (result.code === 0) {
        const media = await probeMedia(job.outputPath);
        job.status = 'completed';
        job.progress = 100;
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
        job.finishedAt = finishTimestamp(job);
        await unlink(job.outputPath).catch(() => {});
      }
    } catch (error) {
      job.status = 'failed';
      job.error =
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'The source file is no longer available.'
          : 'The file could not be processed.';
      job.errorDetails = error instanceof Error ? error.message : null;
      job.finishedAt = finishTimestamp(job);
    } finally {
      this.active = null;
      this.compressionInFlight = false;
      this.compressionPausedForEstimates = false;
      this.notify();
      await this.runPrioritizedEstimates();
      queueMicrotask(() => void this.pump());
    }
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
    if (!runPrioritized || this.prioritizingEstimates || !this.batch || !this.hasPrioritizedEstimate()) {
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

  private run(job: CompressionJob, fallback: boolean) {
    if (job.startedAt === null) {
      job.startedAt = Date.now();
      this.notify();
    }
    const operation = encodeVideo(
      job.inputPath,
      job.outputPath,
      job.durationSeconds,
      job.encoding,
      fallback,
      value => {
        job.progress = value;
        this.notify();
      }
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
    estimateProgress: job.estimateProgress ? { ...job.estimateProgress } : null
  };
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
  return path.join(os.homedir(), videosFolder, 'Video Compressor');
}

function friendlyError(stderr: string) {
  if (/no space left on device/i.test(stderr)) return 'There is not enough free disk space.';
  if (/permission denied|read-only file system/i.test(stderr)) {
    return 'The destination folder is not writable.';
  }
  if (/invalid data found|could not find codec parameters/i.test(stderr)) {
    return 'This video format is not supported or the file is damaged.';
  }
  return 'FFmpeg could not compress this video.';
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
  return job.estimateStatus === 'estimated' && job.estimateKey === encodingKey(job.encoding);
}
