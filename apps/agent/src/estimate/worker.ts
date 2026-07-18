import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  jobConfigurationKey,
  type AgentEventType,
  type CompressionJob
} from '@video-compressor/shared';
import { buildEstimateArgs, buildStaticEstimateArgs } from '../ffmpeg/presets.js';
import { ffmpegPath, ffprobePath } from '../ffmpeg/tools.js';
import {
  outputDimensions,
  outputFrameRate,
  refreshEstimateFromBreakdown
} from '../images/embedding.js';
import { ImageAssetStore } from '../images/store.js';
import { EstimateCache, estimateCacheKey } from './cache.js';
import { createSamplePlan, estimateBreakdownFromSamples } from './sampler.js';

type EstimatePatch = Partial<
  Pick<
    CompressionJob,
    | 'estimateStatus'
    | 'estimatedOutputBytes'
    | 'estimatedSavingPercent'
    | 'estimateRangeMinBytes'
    | 'estimateRangeMaxBytes'
    | 'estimateProgress'
    | 'estimateError'
    | 'estimateKey'
    | 'estimatePriorityOrder'
    | 'estimateBreakdown'
  >
>;

export class EstimationWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private paused = false;
  private pumping = false;
  private generation = 0;
  private currentDone: Promise<void> | null = null;
  private currentJobId: string | null = null;
  private priorityPumping = false;
  private shuttingDown = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private jobs: () => CompressionJob[],
    private update: (id: string, patch: EstimatePatch, event: AgentEventType) => void,
    private compressionRunning: () => boolean,
    private cache = new EstimateCache(),
    private imageStore = new ImageAssetStore()
  ) {}

  async init() {
    await this.cache.load();
    this.schedule();
  }

  schedule(delay = 0) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pump();
    }, delay);
  }

  invalidate() {
    this.generation++;
    this.child?.kill('SIGTERM');
    for (const job of this.jobs()) {
      if (!['ready', 'analyzing'].includes(job.status)) continue;
      this.update(
        job.id,
        {
          estimateStatus: 'waiting',
          estimatedOutputBytes: null,
          estimatedSavingPercent: null,
          estimateRangeMinBytes: null,
          estimateRangeMaxBytes: null,
          estimateProgress: null,
          estimateError: null,
          estimateKey: null,
          estimateBreakdown: null
        },
        'estimate:queued'
      );
    }
    this.schedule(450);
  }

  async pause() {
    this.paused = true;
    this.generation++;
    const child = this.child;
    child?.kill('SIGTERM');
    if (child) {
      setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
      }, 2000).unref();
    }
    await this.currentDone;
  }

  resume() {
    this.paused = false;
    for (const job of this.jobs()) {
      if (job.status === 'ready' && job.estimateStatus === 'cancelled') {
        this.update(job.id, { estimateStatus: 'waiting', estimateError: null }, 'estimate:queued');
      }
    }
    this.schedule();
  }

  async runPrioritized() {
    if (this.priorityPumping || this.shuttingDown || this.compressionRunning()) return false;
    let processed = false;
    this.priorityPumping = true;
    try {
      while (!this.shuttingDown && !this.compressionRunning()) {
        const job = this.nextWaitingJob(true);
        if (!job) break;
        processed = true;
        const run = this.estimate(job, this.generation, true);
        this.currentDone = run;
        this.currentJobId = job.id;
        await run;
        this.currentDone = null;
        this.currentJobId = null;
      }
    } finally {
      this.priorityPumping = false;
      this.currentDone = null;
      this.currentJobId = null;
    }
    return processed;
  }

  cancelPrioritized(id: string) {
    if (this.currentJobId !== id) return;
    this.generation++;
    const child = this.child;
    child?.kill('SIGTERM');
    if (child) {
      setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
      }, 2000).unref();
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    this.paused = true;
    this.generation++;
    this.child?.kill('SIGTERM');
    await this.currentDone;
  }

  private async pump() {
    if (this.pumping || this.paused || this.compressionRunning()) return;
    this.pumping = true;
    try {
      while (!this.paused && !this.compressionRunning()) {
        const job = this.nextWaitingJob(false);
        if (!job) break;
        const run = this.estimate(job, this.generation, false);
        this.currentDone = run;
        this.currentJobId = job.id;
        await run;
        this.currentDone = null;
        this.currentJobId = null;
      }
    } finally {
      this.pumping = false;
      this.currentDone = null;
      this.currentJobId = null;
    }
  }

  private nextWaitingJob(prioritizedOnly: boolean) {
    const waiting = this.jobs().filter(
      job => ['ready', 'queued'].includes(job.status) && job.estimateStatus === 'waiting'
    );
    const prioritized = waiting
      .filter(job => job.estimatePriorityOrder !== null)
      .sort((first, second) => first.estimatePriorityOrder! - second.estimatePriorityOrder!);
    return (
      prioritized[0] ??
      (prioritizedOnly
        ? undefined
        : waiting.find(job => job.status === 'ready' && job.estimatePriorityOrder === null))
    );
  }

  private cancelled(id: string, generation: number, prioritized: boolean) {
    if (this.shuttingDown || generation !== this.generation || this.compressionRunning())
      return true;
    if (!prioritized) return this.paused;
    return this.jobs().find(job => job.id === id)?.estimatePriorityOrder === null;
  }

  private async estimate(job: CompressionJob, generation: number, prioritized: boolean) {
    let temporaryDirectory = '';
    try {
      const source = await stat(job.inputPath);
      const configurationKey = jobConfigurationKey(job.encoding, job.imageEmbedding);
      const key = estimateCacheKey(
        job.inputPath,
        source.size,
        source.mtimeMs,
        job.encoding,
        job.imageEmbedding
      );
      const cached = this.cache.get(key);
      if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();
      if (cached) {
        this.update(
          job.id,
          {
            estimatedOutputBytes: cached.estimatedOutputBytes,
            estimatedSavingPercent: cached.estimatedSavingPercent,
            estimateRangeMinBytes: cached.estimateRangeMinBytes,
            estimateRangeMaxBytes: cached.estimateRangeMaxBytes,
            estimateBreakdown: cached.estimateBreakdown,
            estimateStatus: 'estimated',
            estimateKey: configurationKey,
            estimateProgress: null,
            estimateError: null,
            estimatePriorityOrder: null
          },
          'estimate:completed'
        );
        return;
      }

      const metadata = await probe(job.inputPath);
      const plan = createSamplePlan(metadata.duration);
      if (!plan.length) throw new Error('Duration is unavailable.');
      const staticAsset = job.imageEmbedding?.endImage ?? job.imageEmbedding?.startImage ?? null;
      const totalSteps = plan.length + (staticAsset ? 1 : 0);
      if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();

      this.update(
        job.id,
        {
          estimateStatus: 'estimating',
          estimateKey: configurationKey,
          estimateProgress: { completed: 0, total: totalSteps },
          estimateError: null
        },
        'estimate:started'
      );
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'local-video-estimate-'));
      const sizes: number[] = [];
      const durations: number[] = [];
      for (let index = 0; index < plan.length; index++) {
        if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();
        const sample = plan[index];
        const output = path.join(temporaryDirectory, `sample-${index}.h264`);
        const result = await this.runFfmpeg(
          buildEstimateArgs(job.inputPath, output, sample.start, sample.duration, job.encoding)
        );
        if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();
        if (result === 0) {
          sizes.push((await stat(output)).size);
          durations.push(sample.duration);
        }
        this.update(
          job.id,
          { estimateProgress: { completed: index + 1, total: totalSteps } },
          'estimate:progress'
        );
      }

      if (sizes.length < Math.max(1, Math.ceil(plan.length * 0.5))) {
        throw new Error('Too few representative samples could be read.');
      }
      let staticVideoBytesPerSecond = 0;
      if (staticAsset && job.imageEmbedding) {
        const dimensions = outputDimensions(job);
        if (!dimensions)
          throw new Error('Output dimensions are unavailable for the image estimate.');
        const imagePath = await this.imageStore.validate(staticAsset);
        const staticDuration = 6;
        const output = path.join(temporaryDirectory, 'static-sample.h264');
        const result = await this.runFfmpeg(
          buildStaticEstimateArgs(
            imagePath,
            output,
            staticDuration,
            dimensions.width,
            dimensions.height,
            outputFrameRate(job),
            job.imageEmbedding.fitMode,
            job.encoding
          )
        );
        if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();
        if (result !== 0) throw new Error('The static image sample could not be encoded.');
        staticVideoBytesPerSecond = (await stat(output)).size / staticDuration;
        this.update(
          job.id,
          { estimateProgress: { completed: totalSteps, total: totalSteps } },
          'estimate:progress'
        );
      }

      const audioBytesPerSecond = job.imageEmbedding
        ? 96_000 / 8
        : metadata.hasAudio
          ? metadata.audioBitrate / 8
          : 0;
      const estimateBreakdown = estimateBreakdownFromSamples(
        sizes,
        durations,
        audioBytesPerSecond,
        staticVideoBytesPerSecond
      );
      if (!estimateBreakdown) throw new Error('Not enough sample data.');
      const estimatedJob: CompressionJob = { ...job, estimateBreakdown };
      if (!refreshEstimateFromBreakdown(estimatedJob)) throw new Error('Estimate unavailable.');
      const estimate = {
        estimatedOutputBytes: estimatedJob.estimatedOutputBytes!,
        estimatedSavingPercent: estimatedJob.estimatedSavingPercent!,
        estimateRangeMinBytes: estimatedJob.estimateRangeMinBytes!,
        estimateRangeMaxBytes: estimatedJob.estimateRangeMaxBytes!,
        estimateBreakdown
      };
      await this.cache.set(key, { ...estimate, createdAt: Date.now() });
      if (this.cancelled(job.id, generation, prioritized)) throw new Cancelled();
      this.update(
        job.id,
        {
          ...estimate,
          estimateStatus: 'estimated',
          estimateKey: configurationKey,
          estimateProgress: null,
          estimateError: null,
          estimatePriorityOrder: null
        },
        'estimate:completed'
      );
    } catch (error) {
      if (error instanceof Cancelled) {
        const paused = this.paused && !prioritized;
        this.update(
          job.id,
          {
            estimateStatus: paused ? 'cancelled' : 'waiting',
            estimateProgress: null,
            estimateError: null
          },
          paused ? 'estimate:cancelled' : 'estimate:queued'
        );
      } else {
        this.update(
          job.id,
          {
            estimateStatus: 'unavailable',
            estimateProgress: null,
            estimateError: error instanceof Error ? error.message : 'Estimate unavailable.',
            estimatePriorityOrder: null
          },
          'estimate:failed'
        );
      }
    } finally {
      this.child = null;
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private runFfmpeg(args: string[]) {
    return new Promise<number | null>(resolve => {
      const child = spawn(ffmpegPath, args, { shell: false });
      this.child = child;
      child.on('error', () => resolve(null));
      child.on('close', resolve);
    });
  }
}

class Cancelled extends Error {}

function probe(input: string) {
  return new Promise<{ duration: number; audioBitrate: number; hasAudio: boolean }>(
    (resolve, reject) => {
      const process = spawn(
        ffprobePath,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,bit_rate',
          '-of',
          'json',
          input
        ],
        { shell: false }
      );
      let output = '';
      process.stdout.on('data', data => {
        output += data;
      });
      process.on('error', reject);
      process.on('close', code => {
        try {
          if (code !== 0) throw new Error();
          const value = JSON.parse(output);
          const duration = Number(value.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw new Error();
          const audio = value.streams?.find(
            (stream: { codec_type: string }) => stream.codec_type === 'audio'
          );
          resolve({
            duration,
            audioBitrate: Number(audio?.bit_rate) || 128_000,
            hasAudio: Boolean(audio)
          });
        } catch {
          reject(new Error('FFprobe could not determine duration.'));
        }
      });
    }
  );
}
