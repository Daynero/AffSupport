import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  calculateLandingSummary,
  defaultLandingSettings,
  type LandingAsset,
  type LandingEventType,
  type LandingJob,
  type LandingJobStatus,
  type LandingSettings,
  type LandingSourceKind,
  type LandingState
} from '@video-compressor/shared';
import { fileSize } from '../files/paths.js';
import { encodeImageToWebp } from './images.js';
import { isRewritableFile, rewriteReferences, type RenameMap } from './references.js';
import { classifyAsset, detectLandingRoot, walkFiles } from './scan.js';
import { optimizeVideo } from './video.js';
import {
  LandingPreviewStore,
  type LandingPreviewSide,
  type LandingPreviewVariant
} from './previews.js';
import {
  copyDir,
  createWorkspace,
  landingNameFromSource,
  removeWorkspace,
  unzip,
  uploadedOutputDir,
  writeFolderOutput,
  writeZipOutput
} from './workspace.js';

type Notify = (type?: LandingEventType) => void;

interface LandingJobOptimizerState {
  job: LandingJob | null;
  settings: LandingSettings;
  tools: { ffmpeg: boolean; ffprobe: boolean };
  running: boolean;
}

class LandingJobOptimizer {
  private job: LandingJob | null = null;
  private settings: LandingSettings;
  private workspace: string | null = null;
  private inputDir: string | null = null;
  private landingRoot: string | null = null;
  private destinationDir: string | null = null;
  private pendingName = 'landing';
  private running = false;
  private previews = new LandingPreviewStore();

  constructor(
    private tools: { ffmpeg: boolean; ffprobe: boolean },
    private notify: Notify,
    initialSettings: LandingSettings
  ) {
    this.settings = { ...initialSettings };
  }

  state(): LandingJobOptimizerState {
    return {
      job: this.job ? cloneJob(this.job) : null,
      settings: { ...this.settings },
      tools: this.tools,
      running: this.running
    };
  }

  updateSettings(patch: Partial<LandingSettings>) {
    this.settings = { ...this.settings, ...patch };
    if (this.job && (this.job.status === 'ready' || this.job.status === 'preparing')) {
      this.job.settings = { ...this.settings };
      this.job.outputIsArchive = this.settings.archive;
    }
    this.notify();
  }

  queue(): boolean {
    if (!this.job || this.job.status !== 'ready') return false;
    this.job.status = 'queued';
    this.job.phase = 'queued';
    this.job.progress = 0;
    this.job.settings = { ...this.settings };
    this.job.outputIsArchive = this.settings.archive;
    this.notify();
    return true;
  }

  /** Removes the working copy and clears the current job. */
  async reset() {
    if (this.running) return;
    if (this.workspace) await removeWorkspace(this.workspace);
    this.workspace = null;
    this.inputDir = null;
    this.landingRoot = null;
    this.destinationDir = null;
    this.job = null;
    this.previews.clear();
    this.notify();
  }

  async shutdown() {
    if (this.workspace) await removeWorkspace(this.workspace);
    this.previews.clear();
  }

  async previewContent(
    jobId: string,
    assetId: string,
    side: LandingPreviewSide,
    variant: LandingPreviewVariant
  ) {
    if (this.job?.id !== jobId) return null;
    const asset = this.job.assets.find(item => item.id === assetId);
    if (!asset?.preview?.available) return null;
    return this.previews.content(assetId, side, variant);
  }

  /* ----------------------------- acquisition ----------------------------- */

  private async freshWorkspace(sourceKind: LandingSourceKind, name: string): Promise<string> {
    if (this.workspace) await removeWorkspace(this.workspace);
    this.previews.clear();
    this.workspace = await createWorkspace();
    this.previews.useWorkspace(this.workspace);
    this.inputDir = path.join(this.workspace, 'input');
    await mkdir(this.inputDir, { recursive: true });
    this.pendingName = landingNameFromSource(name);
    this.job = preparingJob(sourceKind, this.settings, this.pendingName);
    this.notify();
    return this.inputDir;
  }

  /** Prepares from a ZIP already present on disk (native picker). */
  async prepareFromZipPath(zipPath: string, uploaded = false) {
    const input = await this.freshWorkspace('zip', zipPath);
    this.destinationDir = uploaded ? uploadedOutputDir() : path.dirname(zipPath);
    await unzip(zipPath, input);
    await this.finalizePreparation();
  }

  /** Prepares from a folder already present on disk (native picker). */
  async prepareFromFolderPath(folderPath: string) {
    const input = await this.freshWorkspace('folder', folderPath);
    this.destinationDir = path.dirname(folderPath);
    await copyDir(folderPath, path.join(input, path.basename(folderPath)));
    await this.finalizePreparation();
  }

  /** Begins a browser upload; returns the directory routes must write into. */
  async beginUpload(sourceKind: LandingSourceKind, name: string): Promise<string> {
    const input = await this.freshWorkspace(sourceKind, name);
    this.destinationDir = uploadedOutputDir();
    return input;
  }

  currentInputDir(): string {
    if (!this.inputDir) throw new Error('No landing upload is in progress.');
    return this.inputDir;
  }

  zipStagingPath(): string {
    if (!this.workspace) throw new Error('No landing upload is in progress.');
    return path.join(this.workspace, 'upload.zip');
  }

  /** Finishes an uploaded ZIP: unpack the received archive, then scan. */
  async finishZipUpload(zipPath: string) {
    if (!this.inputDir) throw new Error('No landing upload is in progress.');
    await unzip(zipPath, this.inputDir);
    await this.finalizePreparation();
  }

  /** Finishes an uploaded folder: the files are already in place, just scan. */
  async finishFolderUpload() {
    await this.finalizePreparation();
  }

  private async finalizePreparation() {
    if (!this.inputDir) throw new Error('No landing workspace is available.');
    this.landingRoot = await detectLandingRoot(this.inputDir);
    const files = await walkFiles(this.landingRoot);
    const assets: LandingAsset[] = [];
    for (const file of files) {
      const kind = classifyAsset(file.relPath);
      if (!kind) continue;
      if (kind === 'image-preserved') {
        const item = asset(
          file.relPath,
          file.size,
          'image',
          'skipped',
          preservedNote(file.relPath)
        );
        const previewCached = await this.previews.cacheOriginal(item.id, file.absPath);
        if (previewCached) attachPreview(item, this.previews);
        assets.push(item);
      } else {
        assets.push(
          asset(file.relPath, file.size, kind === 'video' ? 'video' : 'image', 'pending')
        );
      }
    }
    assets.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const job = preparingJob(this.job?.sourceKind ?? 'zip', this.settings, this.pendingName);
    job.status = 'ready';
    job.phase = 'ready';
    job.progress = 0;
    job.assets = assets;
    job.totalAssets = assets.length;
    job.completedAssets = terminalAssetCount(assets);
    applySummary(job);
    this.job = job;
    this.notify();
  }

  /* ------------------------------ processing ------------------------------ */

  async start(): Promise<boolean> {
    if (
      this.running ||
      !this.job ||
      (this.job.status !== 'ready' && this.job.status !== 'queued')
    ) {
      return false;
    }
    if (!this.landingRoot || !this.destinationDir) return false;
    if (!this.tools.ffmpeg || !this.tools.ffprobe) return false;
    this.running = true;
    this.job.status = 'processing';
    this.job.phase = 'optimizing';
    this.job.progress = 0;
    this.job.totalAssets = this.job.assets.length;
    this.job.completedAssets = terminalAssetCount(this.job.assets);
    this.job.currentAssetId = null;
    this.job.startedAt = Date.now();
    this.job.settings = { ...this.settings };
    this.notify();
    try {
      await this.processAssets();
      this.job.phase = 'rewriting';
      this.job.progress = Math.max(this.job.progress ?? 0, 91);
      this.job.currentAssetId = null;
      this.notify();
      await this.rewriteAndClean();
      this.job.phase = 'packaging';
      this.job.progress = Math.max(this.job.progress ?? 0, 96);
      this.notify();
      await this.produceOutput();
      this.job.status = 'completed';
      this.job.phase = 'completed';
      this.job.progress = 100;
    } catch (error) {
      this.job.status = 'failed';
      this.job.phase = 'failed';
      this.job.currentAssetId = null;
      this.job.error =
        error instanceof Error ? error.message : 'The landing could not be optimized.';
    } finally {
      applySummary(this.job);
      this.job.finishedAt = Date.now();
      this.running = false;
      if (this.inputDir) await rm(this.inputDir, { recursive: true, force: true }).catch(() => {});
      this.inputDir = null;
      this.landingRoot = null;
      this.destinationDir = null;
      this.notify();
    }
    return true;
  }

  private async processAssets() {
    const root = this.landingRoot!;
    const scanned = new Set((await walkFiles(root)).map(file => file.relPath));
    applyJobProgress(this.job!);
    for (const item of this.job!.assets) {
      if (item.status !== 'pending') continue;
      item.status = 'processing';
      this.job!.currentAssetId = item.id;
      applyJobProgress(this.job!);
      this.notify();
      try {
        if (item.type === 'image') await this.processImage(root, item, scanned);
        else await this.processVideo(root, item, scanned);
      } catch (error) {
        await this.previews.remove(item.id);
        item.preview = null;
        item.status = 'failed';
        item.progress = null;
        item.note = error instanceof Error ? error.message : 'processing-failed';
        if (item.type === 'image') {
          const previewCached = await this.previews.cacheOriginal(
            item.id,
            path.join(root, item.relPath)
          );
          if (previewCached) attachPreview(item, this.previews);
        }
      }
      applySummary(this.job!);
      applyJobProgress(this.job!);
      this.notify();
    }
    this.job!.currentAssetId = null;
    this.job!.progress = Math.max(this.job!.progress ?? 0, 88);
  }

  private async processImage(root: string, item: LandingAsset, scanned: Set<string>) {
    const absPath = path.join(root, item.relPath);
    const { webp, width, height } = await encodeImageToWebp(absPath, this.settings.imageQuality);
    const extension = path.posix.extname(item.relPath).toLowerCase();
    if (extension === '.webp') {
      if (webp.byteLength > item.originalSize) {
        const previewCached = await this.previews.cacheOriginal(item.id, absPath, width, height);
        markSkipped(item, 'no-gain');
        if (previewCached) attachPreview(item, this.previews);
        return;
      }
      const previewCached = await this.previews.cache(item.id, absPath, webp, width, height);
      await writeFile(absPath, webp);
      markOptimized(item, webp.byteLength, null);
      if (previewCached) attachPreview(item, this.previews);
      return;
    }
    if (webp.byteLength >= item.originalSize) {
      const previewCached = await this.previews.cacheOriginal(item.id, absPath, width, height);
      markSkipped(item, 'no-gain');
      if (previewCached) attachPreview(item, this.previews);
      return;
    }
    const newRel = replaceExtension(item.relPath, '.webp');
    if (newRel !== item.relPath && scanned.has(newRel)) {
      // A different file already owns the WebP name — never clobber it.
      const previewCached = await this.previews.cacheOriginal(item.id, absPath, width, height);
      markSkipped(item, 'name-collision');
      if (previewCached) attachPreview(item, this.previews);
      return;
    }
    const previewCached = await this.previews.cache(item.id, absPath, webp, width, height);
    await writeFile(path.join(root, newRel), webp);
    scanned.add(newRel);
    markOptimized(item, webp.byteLength, newRel === item.relPath ? null : newRel);
    if (previewCached) attachPreview(item, this.previews);
  }

  private async processVideo(root: string, item: LandingAsset, scanned: Set<string>) {
    const absPath = path.join(root, item.relPath);
    const temporary = path.join(path.dirname(absPath), `.${path.basename(absPath)}.wishly.mp4`);
    await unlink(temporary).catch(() => {});
    const result = await optimizeVideo(absPath, temporary, this.settings.videoQuality, value => {
      item.progress = value;
      applyJobProgress(this.job!);
      this.notify('landing:progress');
    });
    item.progress = null;
    if (result.code !== 0) {
      await unlink(temporary).catch(() => {});
      throw new Error('video-encode-failed');
    }
    const newSize = await fileSize(temporary);
    if (newSize >= item.originalSize) {
      await unlink(temporary).catch(() => {});
      markSkipped(item, 'no-gain');
      return;
    }
    const newRel = replaceExtension(item.relPath, '.mp4');
    if (newRel !== item.relPath && scanned.has(newRel)) {
      await unlink(temporary).catch(() => {});
      markSkipped(item, 'name-collision');
      return;
    }
    await rename(temporary, path.join(root, newRel));
    scanned.add(newRel);
    markOptimized(item, newSize, newRel === item.relPath ? null : newRel);
  }

  private async rewriteAndClean() {
    const root = this.landingRoot!;
    const renames: RenameMap = new Map();
    for (const item of this.job!.assets) {
      if (item.status === 'optimized' && item.newRelPath && item.newRelPath !== item.relPath) {
        renames.set(item.relPath, item.newRelPath);
      }
    }
    if (renames.size) {
      let updated = 0;
      for (const file of await walkFiles(root)) {
        if (!isRewritableFile(file.relPath)) continue;
        const text = await readText(file.absPath);
        if (text === null) continue;
        const result = rewriteReferences(text, file.relPath, renames);
        if (result.count > 0) {
          await writeFile(file.absPath, result.text, 'utf8');
          updated += result.count;
        }
      }
      this.job!.referencesUpdated = updated;
      // Only after references point to the new assets do we drop the originals,
      // and only once the replacement is confirmed on disk.
      for (const [from] of renames) {
        const target = renames.get(from)!;
        if (await exists(path.join(root, target))) {
          await unlink(path.join(root, from)).catch(() => {});
        }
      }
    }
  }

  private async produceOutput() {
    const root = this.landingRoot!;
    const destination = this.destinationDir!;
    if (this.settings.archive) {
      this.job!.outputPath = await writeZipOutput(
        root,
        destination,
        this.pendingName,
        this.workspace!
      );
      this.job!.outputIsArchive = true;
    } else {
      this.job!.outputPath = await writeFolderOutput(root, destination, this.pendingName);
      this.job!.outputIsArchive = false;
    }
  }
}

/** Owns independent workspaces and drains landing jobs through one resource-safe queue. */
export class LandingOptimizer {
  private settings: LandingSettings = defaultLandingSettings();
  private workers: LandingJobOptimizer[] = [];
  private activeUpload: LandingJobOptimizer | null = null;
  private pendingJobIds: string[] = [];
  private pumpPromise: Promise<void> | null = null;

  constructor(
    private tools: { ffmpeg: boolean; ffprobe: boolean },
    private notify: Notify
  ) {}

  state(): LandingState {
    const jobs = this.workers
      .map(worker => worker.state().job)
      .filter((job): job is LandingJob => job !== null);
    return {
      jobs,
      job: jobs.at(-1) ?? null,
      settings: { ...this.settings },
      tools: this.tools,
      running:
        this.pumpPromise !== null ||
        jobs.some(job => job.status === 'queued' || job.status === 'processing')
    };
  }

  updateSettings(patch: Partial<LandingSettings>) {
    this.settings = { ...this.settings, ...patch };
    for (const worker of this.workers) worker.updateSettings(patch);
    this.notify();
  }

  async prepareFromZipPath(zipPath: string, uploaded = false) {
    const worker = this.addWorker();
    try {
      await worker.prepareFromZipPath(zipPath, uploaded);
    } catch (error) {
      await this.discardWorker(worker);
      throw error;
    }
  }

  async prepareFromFolderPath(folderPath: string) {
    const worker = this.addWorker();
    try {
      await worker.prepareFromFolderPath(folderPath);
    } catch (error) {
      await this.discardWorker(worker);
      throw error;
    }
  }

  async beginUpload(sourceKind: LandingSourceKind, name: string): Promise<string> {
    if (this.activeUpload) throw new Error('Another landing upload is still in progress.');
    const worker = this.addWorker();
    this.activeUpload = worker;
    try {
      return await worker.beginUpload(sourceKind, name);
    } catch (error) {
      this.activeUpload = null;
      await this.discardWorker(worker);
      throw error;
    }
  }

  currentInputDir(): string {
    if (!this.activeUpload) throw new Error('No landing upload is in progress.');
    return this.activeUpload.currentInputDir();
  }

  zipStagingPath(): string {
    if (!this.activeUpload) throw new Error('No landing upload is in progress.');
    return this.activeUpload.zipStagingPath();
  }

  async finishZipUpload(zipPath: string) {
    const worker = this.activeUpload;
    if (!worker) throw new Error('No landing upload is in progress.');
    try {
      await worker.finishZipUpload(zipPath);
      this.activeUpload = null;
    } catch (error) {
      this.activeUpload = null;
      await this.discardWorker(worker);
      throw error;
    }
  }

  async finishFolderUpload() {
    const worker = this.activeUpload;
    if (!worker) throw new Error('No landing upload is in progress.');
    try {
      await worker.finishFolderUpload();
      this.activeUpload = null;
    } catch (error) {
      this.activeUpload = null;
      await this.discardWorker(worker);
      throw error;
    }
  }

  async abortUpload() {
    const worker = this.activeUpload;
    this.activeUpload = null;
    if (worker) await this.discardWorker(worker);
  }

  async start(jobIds?: string[]): Promise<boolean> {
    const latestId = this.workers.at(-1)?.state().job?.id;
    const requested = new Set(jobIds ?? (latestId ? [latestId] : []));
    const queued: string[] = [];
    for (const worker of this.workers) {
      const job = worker.state().job;
      if (!job || job.status !== 'ready' || !requested.has(job.id)) continue;
      if (worker.queue()) queued.push(job.id);
    }
    if (!queued.length) return false;
    this.pendingJobIds.push(...queued);
    this.ensurePump();
    while (this.pumpPromise) await this.pumpPromise;
    return true;
  }

  async remove(jobId: string): Promise<boolean> {
    const worker = this.findWorker(jobId);
    if (!worker || worker.state().running) return false;
    await this.discardWorker(worker);
    return true;
  }

  async clearFinished() {
    const removable = this.workers.filter(worker => {
      const status = worker.state().job?.status;
      return status === 'completed' || status === 'failed';
    });
    for (const worker of removable) await this.discardWorker(worker);
  }

  /** Compatibility reset: removes the most recently added non-active landing. */
  async reset() {
    const worker = this.workers.at(-1);
    if (worker && !worker.state().running) await this.discardWorker(worker);
  }

  async shutdown() {
    await Promise.all(this.workers.map(worker => worker.shutdown()));
    this.workers = [];
    this.pendingJobIds = [];
    this.activeUpload = null;
  }

  async previewContent(
    jobId: string,
    assetId: string,
    side: LandingPreviewSide,
    variant: LandingPreviewVariant
  ) {
    return this.findWorker(jobId)?.previewContent(jobId, assetId, side, variant) ?? null;
  }

  outputPath(jobId: string): string | null {
    return this.findWorker(jobId)?.state().job?.outputPath ?? null;
  }

  private addWorker() {
    const worker = new LandingJobOptimizer(this.tools, type => this.notify(type), this.settings);
    this.workers.push(worker);
    return worker;
  }

  private findWorker(jobId: string) {
    return this.workers.find(worker => worker.state().job?.id === jobId) ?? null;
  }

  private async discardWorker(worker: LandingJobOptimizer) {
    const jobId = worker.state().job?.id;
    if (jobId) this.pendingJobIds = this.pendingJobIds.filter(id => id !== jobId);
    if (this.activeUpload === worker) this.activeUpload = null;
    await worker.reset();
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    this.notify();
  }

  private ensurePump() {
    if (this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (this.pendingJobIds.length) this.ensurePump();
      this.notify();
    });
  }

  private async pump() {
    while (this.pendingJobIds.length) {
      const jobId = this.pendingJobIds.shift()!;
      const worker = this.findWorker(jobId);
      if (worker?.state().job?.status === 'queued') await worker.start();
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

function preparingJob(
  sourceKind: LandingSourceKind,
  settings: LandingSettings,
  name: string
): LandingJob {
  return {
    id: randomUUID(),
    name,
    sourceKind,
    status: 'preparing' as LandingJobStatus,
    phase: 'preparing',
    progress: null,
    completedAssets: 0,
    totalAssets: 0,
    currentAssetId: null,
    settings: { ...settings },
    assets: [],
    imagesOptimized: 0,
    videosOptimized: 0,
    filesSkipped: 0,
    filesFailed: 0,
    referencesUpdated: 0,
    originalMediaSize: 0,
    optimizedMediaSize: 0,
    savedBytes: 0,
    savedPercent: 0,
    outputPath: null,
    outputIsArchive: settings.archive,
    error: null,
    warnings: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null
  };
}

function asset(
  relPath: string,
  size: number,
  type: LandingAsset['type'],
  status: LandingAsset['status'],
  note: string | null = null
): LandingAsset {
  return {
    id: randomUUID(),
    relPath,
    fileName: path.posix.basename(relPath),
    type,
    status,
    originalSize: size,
    optimizedSize: status === 'skipped' ? size : null,
    savedBytes: status === 'skipped' ? 0 : null,
    savedPercent: status === 'skipped' ? 0 : null,
    progress: null,
    newRelPath: null,
    note,
    preview: null
  };
}

function markOptimized(item: LandingAsset, optimizedSize: number, newRelPath: string | null) {
  item.status = 'optimized';
  item.optimizedSize = optimizedSize;
  item.savedBytes = Math.max(0, item.originalSize - optimizedSize);
  item.savedPercent = item.originalSize
    ? Math.max(0, Math.round((item.savedBytes / item.originalSize) * 100))
    : 0;
  item.newRelPath = newRelPath;
  item.note = null;
  item.progress = null;
}

function markSkipped(item: LandingAsset, note: string) {
  item.status = 'skipped';
  item.optimizedSize = item.originalSize;
  item.savedBytes = 0;
  item.savedPercent = 0;
  item.newRelPath = null;
  item.note = note;
  item.progress = null;
  item.preview = null;
}

function attachPreview(item: LandingAsset, previews: LandingPreviewStore) {
  const metadata = previews.metadata(item.id);
  item.preview = metadata ? { available: true, ...metadata } : null;
}

const OPTIMIZATION_PROGRESS_SHARE = 88;

/** Media work owns the first 88%; rewriting and packaging finish the job. */
export function landingOptimizationProgress(assets: LandingAsset[]): number {
  if (!assets.length) return 0;
  const completed = terminalAssetCount(assets);
  const active = assets.find(item => item.status === 'processing');
  const activeFraction =
    active?.progress === null || active?.progress === undefined
      ? 0
      : Math.min(1, Math.max(0, active.progress / 100));
  return Math.min(
    OPTIMIZATION_PROGRESS_SHARE,
    ((completed + activeFraction) / assets.length) * OPTIMIZATION_PROGRESS_SHARE
  );
}

function applyJobProgress(job: LandingJob) {
  job.completedAssets = terminalAssetCount(job.assets);
  job.totalAssets = job.assets.length;
  job.progress = Math.max(job.progress ?? 0, landingOptimizationProgress(job.assets));
}

function terminalAssetCount(assets: LandingAsset[]) {
  return assets.filter(item => ['optimized', 'skipped', 'failed'].includes(item.status)).length;
}

function applySummary(job: LandingJob) {
  const summary = calculateLandingSummary(job.assets);
  job.imagesOptimized = summary.imagesOptimized;
  job.videosOptimized = summary.videosOptimized;
  job.filesSkipped = summary.filesSkipped;
  job.filesFailed = summary.filesFailed;
  job.originalMediaSize = summary.originalMediaSize;
  job.optimizedMediaSize = summary.optimizedMediaSize;
  job.savedBytes = summary.savedBytes;
  job.savedPercent = summary.savedPercent;
}

function preservedNote(relPath: string): string {
  return path.posix.extname(relPath).toLowerCase() === '.gif' ? 'animated-safe' : 'vector-safe';
}

function replaceExtension(relPath: string, extension: string): string {
  return relPath.replace(/\.[^./\\]+$/, extension);
}

function cloneJob(job: LandingJob): LandingJob {
  return {
    ...job,
    settings: { ...job.settings },
    assets: job.assets.map(item => ({
      ...item,
      preview: item.preview ? { ...item.preview } : null
    })),
    warnings: [...job.warnings]
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}
