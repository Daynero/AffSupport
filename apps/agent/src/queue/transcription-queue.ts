import { randomUUID } from 'node:crypto';
import { access, constants, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultTranscriptionSettings,
  isTranscribableFileName,
  type SelectionWarning,
  type SourceKind,
  type TranscriptionEventType,
  type TranscriptionJob,
  type TranscriptionModelInfo,
  type TranscriptionSettings,
  type TranscriptionState
} from '@video-compressor/shared';
import { probeDuration } from '../ffmpeg/tools.js';
import { nextTranscriptPath } from '../files/paths.js';
import { transcribe, type TranscribeHandle } from '../whisper/transcriber.js';
import { ModelDownloader } from '../whisper/downloader.js';
import { modelPresent } from '../whisper/tools.js';

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

  constructor(
    private tools: TranscriptionTooling,
    private notify: Notify
  ) {
    this.downloader = new ModelDownloader(
      () => this.notify(),
      () => void this.pump()
    );
  }

  state(): TranscriptionState {
    return {
      jobs: this.jobs.map(job => ({ ...job })),
      running: this.inFlight,
      tools: { ...this.tools, model: modelPresent() },
      model: this.downloader.status(),
      settings: { ...this.settings }
    };
  }

  workActive(): boolean {
    return this.inFlight;
  }

  modelStatus(): TranscriptionModelInfo {
    return this.downloader.status();
  }

  startModelDownload(): void {
    void this.downloader.start();
  }

  cancelModelDownload(): void {
    this.downloader.cancel();
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
    this.notify();
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
      return warn(fileName, 'unsupported-format', 'This file format is not supported.');
    }
    if (
      sourceKind === 'local' &&
      this.jobs.some(job => path.resolve(job.inputPath) === path.resolve(inputPath))
    ) {
      return warn(fileName, 'duplicate', 'This file is already in the queue.');
    }
    try {
      await access(inputPath, constants.R_OK);
    } catch {
      return warn(fileName, 'inaccessible', 'This file could not be read.');
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
      transcriptPath: null,
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
      job.detectedLanguage = null;
      job.finishedAt = null;
      job.requestedLanguage = this.settings.language;
    }
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
    this.jobs = this.jobs.filter(item => item.id !== id);
    await this.cleanupSource(job);
    this.notify();
    return true;
  }

  async removeMany(ids: string[]): Promise<void> {
    const removable = this.jobs.filter(job => ids.includes(job.id) && job.status !== 'processing');
    if (!removable.length) return;
    const removableIds = new Set(removable.map(job => job.id));
    this.jobs = this.jobs.filter(job => !removableIds.has(job.id));
    for (const job of removable) await this.cleanupSource(job);
    this.notify();
  }

  async clearCompleted(): Promise<void> {
    const cleared = this.jobs.filter(
      job => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    );
    if (!cleared.length) return;
    const clearedIds = new Set(cleared.map(job => job.id));
    this.jobs = this.jobs.filter(job => !clearedIds.has(job.id));
    for (const job of cleared) await this.cleanupSource(job);
    this.notify();
  }

  async retry(id: string): Promise<boolean> {
    const job = this.jobs.find(item => item.id === id);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return false;
    return this.start([id]);
  }

  transcriptPath(id: string): string | null {
    return this.jobs.find(job => job.id === id)?.transcriptPath ?? null;
  }

  async shutdown(): Promise<void> {
    this.active?.cancel();
    this.active = null;
  }

  private async pump(): Promise<void> {
    if (this.inFlight) return;
    if (!this.tools.ffmpeg || !this.tools.whisper || !modelPresent()) return;
    const job = this.jobs.find(item => item.status === 'queued');
    if (!job) return;

    this.inFlight = true;
    job.status = 'processing';
    job.startedAt = Date.now();
    job.progress = null;
    this.notify();

    try {
      const transcriptPath = await nextTranscriptPath(
        job.inputPath,
        this.jobs.map(item => item.transcriptPath ?? '').filter(Boolean)
      );
      job.transcriptPath = transcriptPath;
      const handle = transcribe({
        inputPath: job.inputPath,
        transcriptPath,
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
        await unlink(transcriptPath).catch(() => {});
        job.transcriptPath = null;
      } else if (result.code === 0) {
        job.status = 'completed';
        job.progress = 100;
        job.text = result.text;
        job.characters = result.text.length;
        job.detectedLanguage = result.detectedLanguage;
        job.finishedAt = Date.now();
      } else {
        job.status = 'failed';
        job.progress = null;
        job.error =
          result.failedStage === 'extract'
            ? 'The audio track could not be prepared.'
            : 'The transcription engine failed.';
        job.errorDetails = result.stderr.slice(-4_000) || result.spawnErrorCode;
        job.finishedAt = Date.now();
        await unlink(transcriptPath).catch(() => {});
        job.transcriptPath = null;
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
      queueMicrotask(() => void this.pump());
    }
  }

  private async cleanupSource(job: TranscriptionJob): Promise<void> {
    if (job.sourceKind !== 'uploaded') return;
    const resolved = path.resolve(job.inputPath);
    if (!this.importedSources.has(resolved)) return;
    // Keep the import alive if another queued job still points at it.
    if (this.jobs.some(item => path.resolve(item.inputPath) === resolved)) return;
    this.importedSources.delete(resolved);
    await unlink(resolved).catch(() => {});
  }
}

function warn(
  fileName: string,
  reason: SelectionWarning['reason'],
  message: string
): SelectionWarning {
  return { id: randomUUID(), fileName, reason, message };
}
