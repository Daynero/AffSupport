import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LANDING_ASSET_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  calculateLandingSummary,
  phaseOf,
  defaultLandingSettings,
  type LandingAsset,
  type LandingAssetStatus,
  type LandingEventType,
  type LandingJob,
  type LandingJobStatus,
  type LandingStep,
  type LandingSettings,
  type LandingSourceKind,
  type LandingState
} from '@video-compressor/shared';
import { activeGovernorOrNull } from '../power/spawn.js';
import { fileSize } from '../files/paths.js';
import { decideTransition } from '../queue/transitions.js';
import { encodeImageToWebp } from './images.js';
import { isRewritableFile, rewriteReferences, type RenameMap } from './references.js';
import { classifyAsset, detectLandingRoot, walkFiles } from './scan.js';
import { optimizeVideo } from './video.js';
import { stripFileMetadata } from './metadata.js';
import { loadLandingSettings, saveLandingSettings } from './store.js';
import { numberedRenames } from './numbering.js';
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

/**
 * The one place a landing job's status changes.
 *
 * A refusal leaves it exactly as it was and answers false — see
 * `apps/agent/src/queue/transitions.ts` for how the tables were reconciled before this
 * became strict.
 */
/**
 * Moves a landing job and re-derives its phase.
 *
 * `phase` was assigned beside `status` at six sites, and the two could disagree — a job
 * could report `phase: 'optimizing'` while its status already said `cancelled`, because the
 * teardown wrote them at different moments. Six of the nine phases were only ever the status
 * spelled a second time; the other three are steps *within* `processing`, and those are what
 * `step` records now.
 */
function transitionJob(
  job: LandingJob,
  next: LandingJobStatus,
  step: LandingStep | null = null
): boolean {
  if (!decideTransition(LANDING_JOB_LIFECYCLE, job.status, next)) return false;
  job.status = next;
  job.phase = phaseOf(next, step);
  return true;
}

/** Advances the step inside `processing`, re-deriving the phase from it. */
function advanceStep(job: LandingJob, step: LandingStep): void {
  job.phase = phaseOf(job.status, step);
}

/**
 * The same, for one asset inside a job.
 *
 * `skipped` is a real outcome here, not an absence of one: an asset already small enough to
 * leave alone has been dealt with, and recording it as anything else would make the summary
 * count it as work still to do.
 */
function transitionAsset(item: LandingAsset, next: LandingAssetStatus): boolean {
  if (!decideTransition(LANDING_ASSET_LIFECYCLE, item.status, next)) return false;
  item.status = next;
  return true;
}

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
  /** The landing's own file or folder, when it has one on this machine. */
  private sourcePath: string | null = null;
  private pendingName = 'landing';
  private running = false;
  private controller: AbortController | null = null;
  /** Set by cancel() so the aborted run reports "cancelled", not "failed". */
  private cancelling = false;
  private idleWaiters: Array<() => void> = [];
  private previews = new LandingPreviewStore();
  /** The encoder running right now, so a pause has something to hold. */
  private activeChild: ChildProcess | null = null;
  /** Release for the hold the person asked for; non-null exactly while paused. */
  private releaseHold: (() => void) | null = null;

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
    transitionJob(this.job, 'queued');
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
    await this.cancel();
    if (this.workspace) await removeWorkspace(this.workspace);
    this.previews.clear();
  }

  async cancel(): Promise<boolean> {
    if (!this.running || !this.controller) return false;
    this.cancelling = true;
    this.controller.abort(new Error('PROCESS_CANCELED'));
    await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    return true;
  }

  /**
   * Drops a job that is waiting its turn; the pump then skips it. Silent on
   * purpose — "stop all" cancels every waiting landing at once and broadcasts
   * once at the end, rather than a full state frame per card.
   */
  cancelQueued(): boolean {
    if (this.running || this.job?.status !== 'queued') return false;
    transitionJob(this.job, 'cancelled');
    this.job.progress = null;
    this.job.currentAssetId = null;
    this.job.finishedAt = Date.now();
    return true;
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

  /**
   * Where this landing's result belongs.
   *
   * One rule for all three sources, because there was not one before: a landing chosen with
   * the picker landed beside its original, and the same landing dropped onto the page landed
   * in `Downloads/Soty Landings` — the same person, the same landing, two places, and nothing
   * in the interface said which. The choice is now the compressor's own, made in the settings
   * panel and honoured here.
   *
   * `next-to-originals` still needs an original to be next to. A landing that arrived through
   * the browser has none on this machine, so that one keeps the Downloads folder as its
   * answer rather than inventing a location.
   */
  private destinationFor(sourcePath: string | null): string {
    if (this.settings.outputMode === 'chosen-folder' && this.settings.outputFolder) {
      return this.settings.outputFolder;
    }
    return sourcePath ? path.dirname(sourcePath) : uploadedOutputDir();
  }

  /** Prepares from a ZIP already present on disk (native picker). */
  async prepareFromZipPath(zipPath: string, uploaded = false) {
    const input = await this.freshWorkspace('zip', zipPath);
    this.sourcePath = uploaded ? null : zipPath;
    this.destinationDir = this.destinationFor(this.sourcePath);
    await unzip(zipPath, input);
    await this.finalizePreparation();
  }

  /** Prepares from a folder already present on disk (native picker). */
  async prepareFromFolderPath(folderPath: string) {
    const input = await this.freshWorkspace('folder', folderPath);
    this.sourcePath = folderPath;
    this.destinationDir = this.destinationFor(this.sourcePath);
    await copyDir(folderPath, path.join(input, path.basename(folderPath)));
    await this.finalizePreparation();
  }

  /** Begins a browser upload; returns the directory routes must write into. */
  async beginUpload(sourceKind: LandingSourceKind, name: string): Promise<string> {
    const input = await this.freshWorkspace(sourceKind, name);
    this.sourcePath = null;
    this.destinationDir = this.destinationFor(null);
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
    transitionJob(job, 'ready');
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
    this.cancelling = false;
    const controller = new AbortController();
    this.controller = controller;
    transitionJob(this.job, 'processing', 'optimizing');
    this.job.paused = false;
    this.job.progress = 0;
    this.job.totalAssets = this.job.assets.length;
    this.job.completedAssets = terminalAssetCount(this.job.assets);
    this.job.currentAssetId = null;
    this.job.startedAt = Date.now();
    this.job.settings = { ...this.settings };
    this.notify();
    try {
      await this.processAssets(controller.signal);
      throwIfAborted(controller.signal);
      advanceStep(this.job, 'rewriting');
      this.job.progress = Math.max(this.job.progress ?? 0, 91);
      this.job.currentAssetId = null;
      this.notify();
      await this.rewriteAndClean(controller.signal);
      throwIfAborted(controller.signal);
      advanceStep(this.job, 'packaging');
      this.job.progress = Math.max(this.job.progress ?? 0, 96);
      this.notify();
      await this.produceOutput();
      throwIfAborted(controller.signal);
      transitionJob(this.job, 'completed');
      this.job.progress = 100;
    } catch (error) {
      // A user-requested stop aborts the same signal a real failure would, so
      // the flag — not the error — decides which state the card ends up in.
      transitionJob(this.job, this.cancelling ? 'cancelled' : 'failed');
      this.job.currentAssetId = null;
      this.job.error = this.cancelling
        ? null
        : error instanceof Error
          ? error.message
          : 'The landing could not be optimized.';
    } finally {
      /* A held run that finishes — or is stopped — must not leave the governor holding a
         process that no longer exists, and must not come back reported as paused. */
      this.dropHold();
      this.activeChild = null;
      this.job.paused = false;
      this.cancelling = false;
      applySummary(this.job);
      this.job.finishedAt = Date.now();
      this.running = false;
      if (this.inputDir) await rm(this.inputDir, { recursive: true, force: true }).catch(() => {});
      this.inputDir = null;
      this.landingRoot = null;
      this.destinationDir = null;
      this.sourcePath = null;
      this.controller = null;
      this.notify();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
    return true;
  }

  private async processAssets(signal: AbortSignal) {
    const root = this.landingRoot!;
    const scanned = new Set((await walkFiles(root)).map(file => file.relPath));
    applyJobProgress(this.job!);
    for (const item of this.job!.assets) {
      throwIfAborted(signal);
      if (item.status !== 'pending') continue;
      transitionAsset(item, 'processing');
      this.job!.currentAssetId = item.id;
      applyJobProgress(this.job!);
      this.notify();
      try {
        if (!this.wanted(item.type)) {
          /* Turned off in the settings. The file is left exactly as it arrived — including
             its name and every reference to it — and says so on the card rather than
             disappearing from the count. */
          await this.passThrough(root, item);
        } else if (item.type === 'image') {
          await this.processImage(root, item, scanned);
        } else {
          await this.processVideo(root, item, scanned, signal);
        }
        throwIfAborted(signal);
      } catch (error) {
        await this.previews.remove(item.id);
        item.preview = null;
        transitionAsset(item, 'failed');
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
      /*
       * Whatever the run decided not to rewrite still gets its metadata dropped.
       *
       * Re-encoded media loses it on the way through — an image becomes raw pixels before it
       * becomes WebP, and the video preset asks for the tags to go. Everything else keeps the
       * camera, the editing software and, on a phone-shot clip, where it was shot: on a
       * landing that ships to a client, that is the file that says more than the page does.
       * A stream copy, so nothing here is re-compressed.
       */
      await this.stripKeptMetadata(root, item);
      applySummary(this.job!);
      applyJobProgress(this.job!);
      this.notify();
    }
    this.job!.currentAssetId = null;
    this.job!.progress = Math.max(this.job!.progress ?? 0, 88);
  }

  /**
   * Whatever the run decided not to rewrite still gets its metadata dropped.
   *
   * Re-encoded media loses it on the way through — an image becomes raw pixels before it
   * becomes WebP, and the video preset asks for the tags to go. Everything else keeps the
   * camera, the editing software and, on a phone-shot clip, where it was shot: on a landing
   * that ships to a client, that is the file that says more than the page does. A stream
   * copy, so nothing here is re-compressed, and a failure leaves the file as it was.
   */
  private async stripKeptMetadata(root: string, item: LandingAsset): Promise<void> {
    if (!this.settings.stripMetadata || item.status !== 'skipped') return;
    await stripFileMetadata(path.join(root, item.newRelPath ?? item.relPath)).catch(() => false);
  }

  /**
   * Holding a landing mid-encode, the way a compression is held.
   *
   * Through the governor, never by signalling the child here: it is the only thing allowed to
   * stop a managed process, and its duty cycler would otherwise wake, at its next on-window,
   * an encode the person deliberately stopped. It also knows how to suspend on Windows, which
   * has no such signal to send.
   *
   * Only a video encode can be held — it is the one step long enough to be worth holding, and
   * the only one with a child to hold. An image is a fraction of a second; a request that
   * arrives between two of them is answered `unsupported` rather than silently doing nothing.
   */
  setPaused(paused: boolean): 'ok' | 'unsupported' {
    if (!this.job || !this.running) return 'unsupported';
    if (paused === this.job.paused) return 'ok';
    if (paused) {
      if (!this.takeHold()) return 'unsupported';
    } else {
      this.dropHold();
    }
    this.job.paused = paused;
    this.notify();
    return 'ok';
  }

  private takeHold(): boolean {
    const governor = activeGovernorOrNull();
    if (!governor?.throttlingSupported()) return false;
    const child = this.activeChild;
    if (!child || child.pid === undefined) return false;
    this.releaseHold = governor.hold(child, 'landing:paused');
    return true;
  }

  private dropHold(): void {
    const release = this.releaseHold;
    this.releaseHold = null;
    release?.();
  }

  /**
   * The encoder that is running now, and the hold that follows it.
   *
   * The audio-copy fallback spawns a second encoder for the same file. A run the person held
   * must stay held across that swap, or it quietly resumes on a retry nobody asked for.
   */
  private adoptChild(child: ChildProcess | null): void {
    if (child === this.activeChild) return;
    const held = this.releaseHold !== null;
    this.dropHold();
    this.activeChild = child;
    if (held && child) this.takeHold();
  }

  /** Is this kind of media in scope for the run? */
  private wanted(type: LandingAsset['type']): boolean {
    if (type === 'image') return this.settings.optimizeImages;
    if (type === 'video') return this.settings.optimizeVideos;
    return true;
  }

  /**
   * A file the run is not optimizing, handled honestly.
   *
   * The metadata pass that follows in the loop still reaches it — the setting says the
   * landing's media carries no metadata, and a file excused from re-encoding is exactly the
   * one that would otherwise keep all of it. An image also gets its preview cached here, so
   * the card can still show what is in the file.
   */
  private async passThrough(root: string, item: LandingAsset) {
    const absPath = path.join(root, item.relPath);
    if (item.type === 'image') {
      const cached = await this.previews.cacheOriginal(item.id, absPath);
      if (cached) attachPreview(item, this.previews);
    }
    markSkipped(item, this.wanted(item.type) ? 'no-gain' : `${item.type}s-off`);
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
    const newRel = freeRelPath(replaceExtension(item.relPath, '.webp'), scanned);
    const previewCached = await this.previews.cache(item.id, absPath, webp, width, height);
    await writeFile(path.join(root, newRel), webp);
    scanned.add(newRel);
    markOptimized(item, webp.byteLength, newRel === item.relPath ? null : newRel);
    if (previewCached) attachPreview(item, this.previews);
  }

  private async processVideo(
    root: string,
    item: LandingAsset,
    scanned: Set<string>,
    signal: AbortSignal
  ) {
    const absPath = path.join(root, item.relPath);
    const temporary = path.join(path.dirname(absPath), `.${path.basename(absPath)}.soty.mp4`);
    await unlink(temporary).catch(() => {});
    const result = await optimizeVideo(
      absPath,
      temporary,
      this.settings.videoQuality,
      value => {
        item.progress = value;
        applyJobProgress(this.job!);
        this.notify('landing:progress');
      },
      signal,
      this.settings.stripMetadata,
      child => this.adoptChild(child)
    );
    this.adoptChild(null);
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
    const newRel = freeRelPath(replaceExtension(item.relPath, '.mp4'), scanned);
    await rename(temporary, path.join(root, newRel));
    scanned.add(newRel);
    markOptimized(item, newSize, newRel === item.relPath ? null : newRel);
  }

  private async rewriteAndClean(signal: AbortSignal) {
    const root = this.landingRoot!;
    const renames: RenameMap = new Map();
    for (const item of this.job!.assets) {
      if (item.status === 'optimized' && item.newRelPath && item.newRelPath !== item.relPath) {
        renames.set(item.relPath, item.newRelPath);
      }
    }
    /*
     * Renumbering rides on the pass that was already going to rewrite the references.
     *
     * An extension change and a renumber are the same operation seen twice — a file is at one
     * path and needs to be at another, and everything pointing at it has to follow. Doing them
     * in one map means one walk of the landing, and it means the two can never disagree about
     * where a file ended up: `hero.jpg` became `hero.webp` and is now `img3.webp`, and what
     * the HTML gets told is the end of that chain, not the middle of it.
     */
    if (this.settings.renameMedia) {
      const onDisk = new Set((await walkFiles(root)).map(file => file.relPath));
      const numbered = numberedRenames(this.job!.assets, onDisk);
      for (const item of this.job!.assets) {
        const current = item.newRelPath ?? item.relPath;
        const target = numbered.get(current);
        if (!target) continue;
        throwIfAborted(signal);
        await rename(path.join(root, current), path.join(root, target));
        // From the name the landing was written with, so a reference that was never touched
        // by the extension change is still found by its original spelling.
        renames.set(item.relPath, target);
        item.newRelPath = target === item.relPath ? null : target;
      }
    }
    if (renames.size) {
      let updated = 0;
      for (const file of await walkFiles(root)) {
        throwIfAborted(signal);
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
      /* Only after references point to the new assets do we drop the originals, and only
         once the replacement is confirmed on disk. A renumber moved the file rather than
         copying it, so `from` is usually gone already — `unlink` of a missing path is
         exactly the no-op we want, and never the deletion of something still in use. */
      for (const [from, target] of renames) {
        if (from === target) continue;
        if (await exists(path.join(root, target))) {
          await unlink(path.join(root, from)).catch(() => {});
        }
      }
    }
  }

  private async produceOutput() {
    const root = this.landingRoot!;
    /* Read now rather than at preparation: a person who drops three landings, then picks a
       folder, then presses Optimize meant all three to go there. */
    const destination = this.destinationFor(this.sourcePath);
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
  private teamWorkers = new Set<LandingJobOptimizer>();
  private teamJobIds = new Set<string>();
  private activeUpload: LandingJobOptimizer | null = null;
  private pendingJobIds: string[] = [];
  private pumpPromise: Promise<void> | null = null;

  /** Bumped once per broadcast by the wrapper below, never at a call site. */
  private revision = 0;
  /** Every broadcast goes through here, so no site can forget the increment. */
  private readonly notify: Notify;

  constructor(
    private tools: { ffmpeg: boolean; ffprobe: boolean },
    private notifyRaw: Notify
  ) {
    this.notify = ((event?: Parameters<Notify>[0]) => {
      this.revision += 1;
      this.notifyRaw(event);
    }) as Notify;
  }

  state(): LandingState {
    const allJobs = this.workers
      .map(worker => worker.state().job)
      .filter((job): job is LandingJob => job !== null);
    const jobs = this.workers
      .filter(worker => !this.teamWorkers.has(worker))
      .map(worker => worker.state().job)
      .filter((job): job is LandingJob => job !== null);
    return {
      revision: this.revision,
      jobs,
      job: jobs.at(-1) ?? null,
      settings: { ...this.settings },
      tools: this.tools,
      running:
        this.pumpPromise !== null ||
        allJobs.some(job => job.status === 'queued' || job.status === 'processing')
    };
  }

  updateSettings(patch: Partial<LandingSettings>) {
    this.settings = { ...this.settings, ...patch };
    for (const worker of this.workers) worker.updateSettings(patch);
    // Saved, not awaited: a preference that fails to reach the disk still applies to this
    // run, and making the person wait on a write to see their own click is worse than losing
    // the write.
    void saveLandingSettings(this.settings);
    this.notify();
  }

  /**
   * Reads back what was saved last time.
   *
   * Called once at startup rather than in the constructor, because reading a file is
   * asynchronous and the optimizer has to exist before anything can await it.
   */
  async restoreSettings(): Promise<void> {
    this.updateSettings(await loadLandingSettings());
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

  async prepareTeamZip(zipPath: string, settings: LandingSettings): Promise<string> {
    const worker = this.addWorker(settings);
    this.teamWorkers.add(worker);
    try {
      await worker.prepareFromZipPath(zipPath, false);
      const jobId = worker.state().job?.id;
      if (!jobId) throw new Error('PROCESS_FAILED');
      this.teamJobIds.add(jobId);
      this.notify();
      return jobId;
    } catch (error) {
      await this.discardWorker(worker);
      throw error;
    }
  }

  teamJob(jobId: string): LandingJob | null {
    const job = this.findWorker(jobId)?.state().job ?? null;
    return job && this.teamJobIds.has(jobId) ? job : null;
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

  /**
   * Stops one landing (FR-005).
   *
   * The team half of this existed and the user-visible half did not: a landing the user can
   * see could only be stopped by stopping *every* landing, so someone who queued four and
   * wanted to abandon the second had no way to say so. `cancelAll` was the whole vocabulary.
   *
   * Team jobs keep their existing behaviour of being discarded once stopped — they have no
   * row to return to. A user's landing stays in the list as `cancelled`, which is what makes
   * re-running it possible.
   */
  async cancel(jobId: string): Promise<boolean> {
    const worker = this.findWorker(jobId);
    if (!worker) return false;

    // Queued first, then running — the same ordering `cancelAll` uses, and for the same
    // reason: dropping it from the pending list before tearing anything down means the pump
    // cannot pick it up on its way past.
    const wasQueued = worker.cancelQueued();
    if (wasQueued) this.pendingJobIds = this.pendingJobIds.filter(id => id !== jobId);
    const cancelled = wasQueued || (await worker.cancel());
    if (!cancelled) return false;

    if (this.teamJobIds.has(jobId) && !worker.state().running) await this.discardWorker(worker);
    this.notify();
    return true;
  }

  /**
   * Holds one landing where it is, or lets it go again.
   *
   * `not-found` means no such landing; `unsupported` means it cannot be held right now —
   * this platform has no way to stop a running child, or the landing is between files rather
   * than inside a video encode, which is the only step long enough to hold.
   */
  setPaused(jobId: string, paused: boolean): 'ok' | 'not-found' | 'unsupported' {
    const worker = this.findWorker(jobId);
    if (!worker) return 'not-found';
    return worker.setPaused(paused);
  }

  /**
   * Stops every landing the user can see. Queued ones are dropped first so the
   * pump cannot pick another one up while the running landing is torn down,
   * and team landings are skipped: they are invisible in this tool, so a
   * "stop all" here must not kill Team Workspace work.
   */
  async cancelAll(): Promise<number> {
    const own = this.workers.filter(worker => !this.teamWorkers.has(worker));
    let stopped = 0;
    for (const worker of own) {
      if (!worker.cancelQueued()) continue;
      const jobId = worker.state().job?.id;
      if (jobId) this.pendingJobIds = this.pendingJobIds.filter(id => id !== jobId);
      stopped += 1;
    }
    for (const worker of own) if (await worker.cancel()) stopped += 1;
    this.notify();
    return stopped;
  }

  async clearFinished() {
    const removable = this.workers.filter(worker => {
      const status = worker.state().job?.status;
      return status === 'completed' || status === 'failed' || status === 'cancelled';
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
    this.teamWorkers.clear();
    this.teamJobIds.clear();
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

  private addWorker(settings: LandingSettings = this.settings) {
    const worker = new LandingJobOptimizer(this.tools, type => this.notify(type), settings);
    this.workers.push(worker);
    return worker;
  }

  private findWorker(jobId: string) {
    return this.workers.find(worker => worker.state().job?.id === jobId) ?? null;
  }

  private async discardWorker(worker: LandingJobOptimizer) {
    const jobId = worker.state().job?.id;
    if (jobId) this.pendingJobIds = this.pendingJobIds.filter(id => id !== jobId);
    if (jobId) this.teamJobIds.delete(jobId);
    if (this.activeUpload === worker) this.activeUpload = null;
    await worker.reset();
    this.teamWorkers.delete(worker);
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

/**
 * The wanted path, or the next one beside it that nothing owns.
 *
 * A landing that ships both `doc.png` and `doc.webp` used to cost the run the whole of the
 * PNG: converting it would have produced a name a different file already had, so the file was
 * left alone. On the landing this was found on that one skipped file was **1.66 MB of a
 * 2.58 MB result** — two thirds of the finished weight, given up to avoid a name clash, with
 * nothing on screen saying so.
 *
 * Never overwriting was right; stopping was not. `doc-2.webp` costs a suffix and saves the
 * megabyte, and the reference pass that already exists rewrites every mention of it.
 */
export function freeRelPath(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  const extension = path.posix.extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  for (let n = 2; n < 1_000; n += 1) {
    const candidate = `${stem}-${n}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  // A thousand files of one name is not a landing; leaving it alone is the honest answer.
  return wanted;
}

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
    // Derived here too, so the initial value cannot be the one place the two disagree.
    phase: phaseOf('preparing', null),
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
    paused: false,
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
  transitionAsset(item, 'optimized');
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
  transitionAsset(item, 'skipped');
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

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
}

async function readText(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}
