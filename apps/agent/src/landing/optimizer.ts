import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

export class LandingOptimizer {
  private job: LandingJob | null = null;
  private settings: LandingSettings = defaultLandingSettings();
  private workspace: string | null = null;
  private inputDir: string | null = null;
  private landingRoot: string | null = null;
  private destinationDir: string | null = null;
  private pendingName = 'landing';
  private running = false;

  constructor(
    private tools: { ffmpeg: boolean; ffprobe: boolean },
    private notify: Notify
  ) {}

  state(): LandingState {
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
    }
    this.notify();
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
    this.notify();
  }

  async shutdown() {
    if (this.workspace) await removeWorkspace(this.workspace);
  }

  /* ----------------------------- acquisition ----------------------------- */

  private async freshWorkspace(sourceKind: LandingSourceKind): Promise<string> {
    if (this.workspace) await removeWorkspace(this.workspace);
    this.workspace = await createWorkspace();
    this.inputDir = path.join(this.workspace, 'input');
    await mkdir(this.inputDir, { recursive: true });
    this.job = preparingJob(sourceKind, this.settings);
    this.notify();
    return this.inputDir;
  }

  /** Prepares from a ZIP already present on disk (native picker). */
  async prepareFromZipPath(zipPath: string, uploaded = false) {
    const input = await this.freshWorkspace('zip');
    this.pendingName = landingNameFromSource(zipPath);
    this.destinationDir = uploaded ? uploadedOutputDir() : path.dirname(zipPath);
    await unzip(zipPath, input);
    await this.finalizePreparation();
  }

  /** Prepares from a folder already present on disk (native picker). */
  async prepareFromFolderPath(folderPath: string) {
    const input = await this.freshWorkspace('folder');
    this.pendingName = landingNameFromSource(folderPath);
    this.destinationDir = path.dirname(folderPath);
    await copyDir(folderPath, path.join(input, path.basename(folderPath)));
    await this.finalizePreparation();
  }

  /** Begins a browser upload; returns the directory routes must write into. */
  async beginUpload(sourceKind: LandingSourceKind, name: string): Promise<string> {
    const input = await this.freshWorkspace(sourceKind);
    this.pendingName = landingNameFromSource(name);
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
        assets.push(
          asset(file.relPath, file.size, 'image', 'skipped', preservedNote(file.relPath))
        );
      } else {
        assets.push(
          asset(file.relPath, file.size, kind === 'video' ? 'video' : 'image', 'pending')
        );
      }
    }
    assets.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const job = preparingJob(this.job?.sourceKind ?? 'zip', this.settings);
    job.name = this.pendingName;
    job.status = 'ready';
    job.assets = assets;
    applySummary(job);
    this.job = job;
    this.notify();
  }

  /* ------------------------------ processing ------------------------------ */

  async start(): Promise<boolean> {
    if (this.running || !this.job || this.job.status !== 'ready') return false;
    if (!this.landingRoot || !this.destinationDir) return false;
    if (!this.tools.ffmpeg || !this.tools.ffprobe) return false;
    this.running = true;
    this.job.status = 'processing';
    this.job.startedAt = Date.now();
    this.job.settings = { ...this.settings };
    this.notify();
    try {
      await this.processAssets();
      await this.rewriteAndClean();
      await this.produceOutput();
      this.job.status = 'completed';
    } catch (error) {
      this.job.status = 'failed';
      this.job.error =
        error instanceof Error ? error.message : 'The landing could not be optimized.';
    } finally {
      applySummary(this.job);
      this.job.finishedAt = Date.now();
      this.running = false;
      if (this.workspace) await removeWorkspace(this.workspace);
      this.workspace = null;
      this.inputDir = null;
      this.landingRoot = null;
      this.notify();
    }
    return true;
  }

  private async processAssets() {
    const root = this.landingRoot!;
    const scanned = new Set((await walkFiles(root)).map(file => file.relPath));
    for (const item of this.job!.assets) {
      if (item.status !== 'pending') continue;
      item.status = 'processing';
      this.notify();
      try {
        if (item.type === 'image') await this.processImage(root, item, scanned);
        else await this.processVideo(root, item, scanned);
      } catch (error) {
        item.status = 'failed';
        item.progress = null;
        item.note = error instanceof Error ? error.message : 'processing-failed';
      }
      applySummary(this.job!);
      this.notify();
    }
  }

  private async processImage(root: string, item: LandingAsset, scanned: Set<string>) {
    const absPath = path.join(root, item.relPath);
    const { webp } = await encodeImageToWebp(absPath, this.settings.imageQuality);
    const extension = path.posix.extname(item.relPath).toLowerCase();
    if (extension === '.webp') {
      // Re-optimizing an existing WebP only pays off with a real size win.
      if (webp.byteLength < item.originalSize * 0.98) {
        await writeFile(absPath, webp);
        markOptimized(item, webp.byteLength, null);
      } else {
        markSkipped(item, 'already-optimized');
      }
      return;
    }
    if (webp.byteLength >= item.originalSize) {
      markSkipped(item, 'no-gain');
      return;
    }
    const newRel = replaceExtension(item.relPath, '.webp');
    if (newRel !== item.relPath && scanned.has(newRel)) {
      // A different file already owns the WebP name — never clobber it.
      markSkipped(item, 'name-collision');
      return;
    }
    await writeFile(path.join(root, newRel), webp);
    scanned.add(newRel);
    markOptimized(item, webp.byteLength, newRel === item.relPath ? null : newRel);
  }

  private async processVideo(root: string, item: LandingAsset, scanned: Set<string>) {
    const absPath = path.join(root, item.relPath);
    const temporary = path.join(path.dirname(absPath), `.${path.basename(absPath)}.wishly.mp4`);
    await unlink(temporary).catch(() => {});
    const result = await optimizeVideo(absPath, temporary, this.settings.videoQuality, value => {
      item.progress = value;
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

/* -------------------------------- helpers -------------------------------- */

function preparingJob(sourceKind: LandingSourceKind, settings: LandingSettings): LandingJob {
  return {
    id: randomUUID(),
    name: '',
    sourceKind,
    status: 'preparing' as LandingJobStatus,
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
    note
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
    assets: job.assets.map(item => ({ ...item })),
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
