import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { nextConvertedImagePath } from '../files/paths.js';
import {
  IMAGE_CONVERSION_EXTENSIONS,
  ImageConversionError,
  convertImage,
  sourceAlreadyUsesFormat,
  type ImageConversionFormat
} from './image-converter.js';

export type MediaActionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'skipped';

export interface ImageConversionJob {
  id: string;
  kind: 'image-conversion';
  inputPath: string;
  outputPath: string | null;
  targetFormat: ImageConversionFormat;
  status: MediaActionStatus;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MediaActionState {
  running: boolean;
  jobs: ImageConversionJob[];
}

type Notify = () => void;
type ImageConverter = typeof convertImage;

export class MediaActionQueue {
  private jobs: ImageConversionJob[] = [];
  private pumpPromise: Promise<void> | null = null;
  private stopping = false;
  private additionsInFlight = 0;
  private additionsDrained: Array<() => void> = [];

  constructor(
    private readonly notify: Notify = () => {},
    private readonly imageConverter: ImageConverter = convertImage
  ) {}

  state(): MediaActionState {
    return {
      running: this.workActive(),
      jobs: this.jobs.map(job => ({ ...job }))
    };
  }

  workActive() {
    return (
      this.additionsInFlight > 0 ||
      Boolean(this.pumpPromise) ||
      this.jobs.some(job => job.status === 'queued')
    );
  }

  async addImageConversions(paths: string[], targetFormat: ImageConversionFormat) {
    if (this.stopping) {
      throw new ImageConversionError('QUEUE_STOPPING', 'Wishly is shutting down.');
    }
    this.additionsInFlight += 1;
    try {
      const accepted: ImageConversionJob[] = [];
      for (const input of paths) {
        const inputPath = path.resolve(input);
        const now = Date.now();
        const job: ImageConversionJob = {
          id: randomUUID(),
          kind: 'image-conversion',
          inputPath,
          outputPath: null,
          targetFormat,
          status: 'queued',
          errorCode: null,
          error: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null
        };
        if (sourceAlreadyUsesFormat(inputPath, targetFormat)) {
          job.status = 'skipped';
          job.errorCode = 'ALREADY_TARGET_FORMAT';
          job.error = 'The image already uses the selected format.';
          job.finishedAt = now;
        } else {
          job.outputPath = await this.nextPath(job);
        }
        this.jobs.push(job);
        accepted.push({ ...job });
      }
      this.trimHistory();
      this.notify();
      this.schedule();
      return accepted;
    } finally {
      this.additionsInFlight -= 1;
      if (this.additionsInFlight === 0) {
        for (const resolve of this.additionsDrained.splice(0)) resolve();
      }
    }
  }

  async shutdown() {
    this.stopping = true;
    if (this.additionsInFlight > 0) {
      await new Promise<void>(resolve => this.additionsDrained.push(resolve));
    }
    this.schedule(true);
    await this.pumpPromise;
  }

  private schedule(allowWhileStopping = false) {
    if (
      this.pumpPromise ||
      (this.stopping && !allowWhileStopping) ||
      !this.jobs.some(job => job.status === 'queued')
    )
      return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      this.notify();
      if (!this.stopping) this.schedule();
    });
  }

  private async pump() {
    while (true) {
      const job = this.jobs.find(candidate => candidate.status === 'queued');
      if (!job) return;
      job.status = 'processing';
      job.startedAt = Date.now();
      this.notify();
      try {
        await this.process(job);
        job.status = 'completed';
      } catch (error) {
        job.status = 'failed';
        job.errorCode =
          error instanceof ImageConversionError ? error.code : 'IMAGE_CONVERSION_FAILED';
        job.error = error instanceof Error ? error.message : 'The image could not be converted.';
      } finally {
        job.finishedAt = Date.now();
        this.notify();
      }
    }
  }

  private async process(job: ImageConversionJob) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      job.outputPath ??= await this.nextPath(job);
      try {
        await this.imageConverter(job.inputPath, job.outputPath, job.targetFormat);
        return;
      } catch (error) {
        if (!(error instanceof ImageConversionError) || error.code !== 'OUTPUT_EXISTS') throw error;
        job.outputPath = await this.nextPath(job);
      }
    }
    throw new ImageConversionError(
      'OUTPUT_COLLISION',
      'Wishly could not reserve a unique output name.'
    );
  }

  private nextPath(current: ImageConversionJob) {
    const reserved = this.jobs
      .filter(job => job !== current && job.outputPath)
      .map(job => job.outputPath as string);
    return nextConvertedImagePath(
      current.inputPath,
      IMAGE_CONVERSION_EXTENSIONS[current.targetFormat],
      reserved
    );
  }

  private trimHistory() {
    const active = this.jobs.filter(job => job.status === 'queued' || job.status === 'processing');
    const terminal = this.jobs
      .filter(job => job.status !== 'queued' && job.status !== 'processing')
      .slice(-100);
    this.jobs = [...terminal, ...active];
  }
}
