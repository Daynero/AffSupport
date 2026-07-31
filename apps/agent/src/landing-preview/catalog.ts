import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import type {
  LandingPreviewEventType,
  LandingPreviewItem,
  LandingPreviewRenderSettings,
  LandingPreviewState
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { extractZipSafely } from './archive.js';
import { LandingPageRenderer, type LandingRenderResult } from './renderer.js';
import { discoverLandings, type DiscoveredLanding } from './scanner.js';

const STATE_VERSION = 1;
/** Bumped whenever the capture pipeline changes in a way that invalidates caches. */
const RENDER_PIPELINE_VERSION = 'v2-segmented';
const MAX_VISIBLE_WARNINGS = 8;
/** How many landings render at once. Kept low to bound Chromium memory. */
const RENDER_CONCURRENCY = Math.min(4, Math.max(1, availableParallelism() - 2));

export const DEVICE_VIEWPORTS: Record<
  LandingPreviewRenderSettings['device'],
  { width: number; height: number; mobile: boolean }
> = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 834, height: 1112, mobile: true },
  mobile: { width: 390, height: 844, mobile: true }
};

const DEFAULT_SETTINGS: LandingPreviewRenderSettings = {
  device: 'desktop',
  colorScheme: 'light'
};

/** Preview cache key: previews re-render whenever any of these inputs change. */
function renderProfileOf(settings: LandingPreviewRenderSettings): string {
  const viewport = DEVICE_VIEWPORTS[settings.device];
  return `${settings.device}-${viewport.width}x${viewport.height}-${settings.colorScheme}-${RENDER_PIPELINE_VERSION}`;
}

function normalizeSettings(value: unknown): LandingPreviewRenderSettings {
  const source = (value ?? {}) as Partial<LandingPreviewRenderSettings>;
  return {
    device: source.device === 'tablet' || source.device === 'mobile' ? source.device : 'desktop',
    colorScheme: source.colorScheme === 'dark' ? 'dark' : 'light'
  };
}

interface StoredLanding extends LandingPreviewItem {
  key: string;
  fingerprint: string;
  renderProfile: string;
  entryFile: string;
  previewFile: string | null;
  previewFiles: string[];
}

interface StoredCatalog {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
  sourceAvailable: boolean;
  landings: StoredLanding[];
  warnings: string[];
  updatedAt: number | null;
}

interface StoredState {
  version: number;
  activeCatalogId: string | null;
  catalogs: StoredCatalog[];
  settings?: LandingPreviewRenderSettings;
}

export interface LandingRenderer {
  init(): Promise<void>;
  availability(): { available: boolean; error: string | null };
  render(input: {
    root: string;
    entryFile: string;
    outputPath: string;
    signal?: AbortSignal;
    viewport?: { width: number; height: number; mobile: boolean };
    colorScheme?: LandingPreviewRenderSettings['colorScheme'];
  }): Promise<LandingRenderResult>;
  shutdown(): Promise<void>;
}

export class LandingPreviewCatalog {
  private readonly root: string;
  private readonly statePath: string;
  private readonly renderer: LandingRenderer;
  private catalogs: StoredCatalog[] = [];
  private activeCatalogId: string | null = null;
  private controller: AbortController | null = null;
  private activeRun: Promise<void> | null = null;
  private saveChain = Promise.resolve();
  /** De-dupes concurrent ZIP extraction when several landings share one archive. */
  private archiveWork = new Map<string, Promise<void>>();
  private notify: (type?: LandingPreviewEventType) => void = () => {};
  private progress: LandingPreviewState['progress'] = emptyProgress();
  private running = false;
  private error: string | null = null;
  private settings: LandingPreviewRenderSettings = { ...DEFAULT_SETTINGS };

  constructor(options: { root?: string; renderer?: LandingRenderer } = {}) {
    this.root = options.root ?? path.join(applicationSupportRoot(), 'LandingPreviews');
    this.statePath = path.join(this.root, 'state.json');
    this.renderer = options.renderer ?? new LandingPageRenderer();
  }

  setNotify(notify: (type?: LandingPreviewEventType) => void) {
    this.notify = notify;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as StoredState;
      if (parsed.version === STATE_VERSION && Array.isArray(parsed.catalogs)) {
        this.catalogs = parsed.catalogs.map(normalizeCatalog).filter(Boolean) as StoredCatalog[];
        this.activeCatalogId = this.catalogs.some(item => item.id === parsed.activeCatalogId)
          ? parsed.activeCatalogId
          : (this.catalogs[0]?.id ?? null);
        this.settings = normalizeSettings(parsed.settings);
      }
    } catch {
      this.catalogs = [];
      this.activeCatalogId = null;
    }
    await this.renderer.init();
    await this.revalidateCachedPreviews();
  }

  state(): LandingPreviewState {
    const active = this.activeCatalog();
    return {
      catalogs: [...this.catalogs]
        .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
        .map(item => ({
          id: item.id,
          name: item.name,
          landingCount: item.landings.length,
          lastOpenedAt: item.lastOpenedAt,
          sourceAvailable: item.sourceAvailable
        })),
      activeCatalogId: active?.id ?? null,
      activeCatalogName: active?.name ?? null,
      landings: active?.landings.map(publicLanding) ?? [],
      running: this.running,
      progress: { ...this.progress },
      renderer: this.renderer.availability(),
      settings: { ...this.settings },
      warnings: [...(active?.warnings ?? [])],
      error: this.error,
      updatedAt: active?.updatedAt ?? null
    };
  }

  busy() {
    return this.running;
  }

  private renderProfile() {
    return renderProfileOf(this.settings);
  }

  /** Applies new render settings and re-renders anything that no longer matches. */
  async updateSettings(partial: Partial<LandingPreviewRenderSettings>) {
    if (this.running) return false;
    const next = normalizeSettings({ ...this.settings, ...partial });
    if (renderProfileOf(next) === this.renderProfile()) {
      this.settings = next;
      await this.persist();
      this.notify();
      return true;
    }
    this.settings = next;
    await this.persist();
    const catalog = this.activeCatalog();
    if (catalog) this.startRun(catalog, 'changed');
    else this.notify();
    return true;
  }

  async openRoot(rootPath: string) {
    if (this.running) return false;
    const canonical = await realpath(path.resolve(rootPath));
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error('Choose a folder that contains landings.');
    let catalog = this.catalogs.find(item => item.rootPath === canonical);
    if (!catalog) {
      catalog = {
        id: `catalog_${digest(canonical).slice(0, 20)}`,
        name: path.basename(canonical) || canonical,
        rootPath: canonical,
        lastOpenedAt: Date.now(),
        sourceAvailable: true,
        landings: [],
        warnings: [],
        updatedAt: null
      };
      this.catalogs.push(catalog);
    } else {
      catalog.name = path.basename(canonical) || canonical;
      catalog.rootPath = canonical;
      catalog.lastOpenedAt = Date.now();
      catalog.sourceAvailable = true;
    }
    this.activeCatalogId = catalog.id;
    this.error = null;
    await this.persist();
    this.startRun(catalog, 'changed');
    return true;
  }

  async activate(catalogId: string) {
    if (this.running) return false;
    const catalog = this.catalogs.find(item => item.id === catalogId);
    if (!catalog) return false;
    this.activeCatalogId = catalog.id;
    catalog.lastOpenedAt = Date.now();
    this.error = null;
    await this.persist();
    this.startRun(catalog, 'changed');
    return true;
  }

  refresh(mode: 'changed' | 'all' | 'current', landingId?: string) {
    if (this.running) return false;
    const catalog = this.activeCatalog();
    if (!catalog) return false;
    if (
      mode === 'current' &&
      (!landingId || !catalog.landings.some(item => item.id === landingId))
    ) {
      return false;
    }
    this.startRun(catalog, mode, landingId);
    return true;
  }

  cancel() {
    if (!this.controller) return false;
    this.controller.abort(new Error('Preview generation cancelled.'));
    return true;
  }

  sourcePath(landingId: string): string | null {
    const catalog = this.activeCatalog();
    const landing = catalog?.landings.find(item => item.id === landingId);
    if (!catalog || !landing) return null;
    return safeSourcePath(catalog.rootPath, landing.sourceRelativePath);
  }

  sourceLocation(
    landingId: string
  ): { path: string; kind: LandingPreviewItem['sourceKind'] } | null {
    const catalog = this.activeCatalog();
    const landing = catalog?.landings.find(item => item.id === landingId);
    if (!catalog || !landing) return null;
    const source = safeSourcePath(catalog.rootPath, landing.sourceRelativePath);
    return source ? { path: source, kind: landing.sourceKind } : null;
  }

  extractedPath(landingId: string): string | null {
    const catalog = this.activeCatalog();
    const landing = catalog?.landings.find(item => item.id === landingId);
    if (!catalog || !landing || landing.sourceKind !== 'zip') return null;
    const extracted = this.archiveContentPath(catalog, landing);
    return landing.archiveRoot
      ? path.join(extracted, ...landing.archiveRoot.split('/'))
      : extracted;
  }

  async previewPath(landingId: string, segment = 0): Promise<string | null> {
    const landing = this.activeCatalog()?.landings.find(item => item.id === landingId);
    const previewFile = landing ? previewFilesOf(landing)[segment] : null;
    if (!landing?.previewAvailable || !previewFile) return null;
    const candidate = safeCachePath(this.root, previewFile);
    if (!candidate) return null;
    return (await isUsablePreview(candidate)) ? candidate : null;
  }

  async removeCatalog(catalogId: string) {
    if (this.running) return false;
    const index = this.catalogs.findIndex(item => item.id === catalogId);
    if (index < 0) return false;
    const [removed] = this.catalogs.splice(index, 1);
    await rm(this.catalogCacheRoot(removed), { recursive: true, force: true }).catch(() => {});
    if (this.activeCatalogId === catalogId) this.activeCatalogId = this.catalogs[0]?.id ?? null;
    await this.persist();
    this.notify();
    return true;
  }

  async clearActiveCache() {
    if (this.running) return false;
    const catalog = this.activeCatalog();
    if (!catalog) return false;
    await rm(this.catalogCacheRoot(catalog), { recursive: true, force: true });
    for (const landing of catalog.landings) {
      landing.previewAvailable = false;
      landing.previewFile = null;
      landing.previewFiles = [];
      landing.previewWidth = null;
      landing.previewHeight = null;
      landing.renderedAt = null;
      landing.extractedAvailable = false;
      landing.status = 'queued';
      landing.stale = false;
    }
    catalog.updatedAt = null;
    await this.persist();
    this.notify();
    return true;
  }

  async shutdown() {
    this.controller?.abort(new Error('Wishly is shutting down.'));
    await this.activeRun?.catch(() => {});
    await this.saveChain;
    await this.renderer.shutdown();
  }

  private startRun(
    catalog: StoredCatalog,
    mode: 'changed' | 'all' | 'current',
    landingId?: string
  ) {
    const controller = new AbortController();
    this.controller = controller;
    const task = this.run(catalog, mode, landingId, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          this.error = errorMessage(error);
          this.progress.phase = 'failed';
        }
      })
      .finally(async () => {
        if (this.controller === controller) this.controller = null;
        if (this.activeRun === task) this.activeRun = null;
        this.running = false;
        if (controller.signal.aborted) this.progress.phase = 'cancelled';
        await this.persist().catch(() => {});
        this.notify();
      });
    this.activeRun = task;
  }

  private async run(
    catalog: StoredCatalog,
    mode: 'changed' | 'all' | 'current',
    landingId: string | undefined,
    signal: AbortSignal
  ) {
    this.running = true;
    this.error = null;
    this.progress = { phase: 'scanning', completed: 0, total: 0, currentLandingId: null };
    this.notify('landing-preview:progress');
    let discovery;
    try {
      await access(catalog.rootPath);
      catalog.sourceAvailable = true;
      discovery = await discoverLandings(catalog.rootPath, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      catalog.sourceAvailable = false;
      throw new Error(`The source folder is unavailable: ${errorMessage(error)}`, { cause: error });
    }
    throwIfAborted(signal);
    catalog.warnings = discovery.warnings.slice(0, MAX_VISIBLE_WARNINGS);
    const previous = new Map(catalog.landings.map(item => [item.key, item]));
    const next: StoredLanding[] = [];
    for (const discovered of discovery.landings) {
      const old = previous.get(discovered.key);
      previous.delete(discovered.key);
      const previewStillExists = old
        ? await previewFilesUsable(this.root, previewFilesOf(old))
        : false;
      const unchanged =
        Boolean(old) &&
        old!.fingerprint === discovered.fingerprint &&
        old!.renderProfile === this.renderProfile() &&
        previewStillExists;
      const forced = mode === 'all' || (mode === 'current' && old?.id === landingId);
      next.push(
        reconcileLanding(catalog.id, discovered, old, {
          reusePreview: unchanged && !forced,
          keepOldPreview: previewStillExists,
          renderProfile: this.renderProfile()
        })
      );
    }
    catalog.landings = next;
    catalog.updatedAt = Date.now();
    await this.cleanupUnusedArchiveCache(catalog);
    for (const removed of previous.values()) {
      await Promise.all(
        previewFilesOf(removed).map(file => {
          const target = safeCachePath(this.root, file);
          return target ? rm(target, { force: true }).catch(() => {}) : Promise.resolve();
        })
      );
    }
    const queued = catalog.landings.filter(
      item => item.status === 'queued' && (mode !== 'current' || item.id === landingId)
    );
    this.progress.total = queued.length;
    await this.persist();
    this.notify();
    if (!queued.length) {
      this.progress.phase = 'completed';
      this.notify('landing-preview:progress');
      return;
    }
    const renderer = this.renderer.availability();
    if (!renderer.available) {
      for (const landing of queued) {
        landing.status = 'failed';
        landing.error = renderer.error;
      }
      throw new Error(renderer.error ?? 'Chromium renderer is unavailable.');
    }
    this.progress.phase = 'rendering';
    this.notify('landing-preview:progress');
    await this.renderQueue(catalog, queued, signal);
    throwIfAborted(signal);
    this.progress.currentLandingId = null;
    this.progress.phase = 'completed';
    catalog.updatedAt = Date.now();
  }

  /** Renders queued landings through a small pool of concurrent workers. */
  private async renderQueue(catalog: StoredCatalog, queued: StoredLanding[], signal: AbortSignal) {
    let cursor = 0;
    const takeNext = () => (cursor < queued.length ? queued[cursor++] : null);
    const worker = async () => {
      for (let landing = takeNext(); landing; landing = takeNext()) {
        throwIfAborted(signal);
        await this.renderOne(catalog, landing, signal);
      }
    };
    const workers = Array.from({ length: Math.min(RENDER_CONCURRENCY, queued.length) }, () =>
      worker()
    );
    const results = await Promise.allSettled(workers);
    // Wait for every worker to unwind (cancellation, failures) before surfacing.
    throwIfAborted(signal);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  private async renderOne(catalog: StoredCatalog, landing: StoredLanding, signal: AbortSignal) {
    let obsoletePreviewFiles: string[] = [];
    let generatedPreviewFiles: string[] = [];
    this.progress.currentLandingId = landing.id;
    landing.status = 'rendering';
    landing.error = null;
    this.notify('landing-preview:progress');
    try {
      const prepared = await this.prepareLanding(catalog, landing, signal);
      throwIfAborted(signal);
      const previewDirectory = path.join(this.catalogCacheRoot(catalog), 'previews');
      await mkdir(previewDirectory, { recursive: true });
      const outputPath = path.join(
        previewDirectory,
        `${landing.id}.${randomUUID()}.segment-0.webp`
      );
      const viewport = DEVICE_VIEWPORTS[this.settings.device];
      const result = await this.renderer.render({
        root: prepared.root,
        entryFile: prepared.entryFile,
        outputPath,
        signal,
        viewport,
        colorScheme: this.settings.colorScheme
      });
      generatedPreviewFiles = result.segmentFiles;
      if (!generatedPreviewFiles.length) {
        throw new Error('The renderer did not return a landing preview.');
      }
      const previewRoot = path.resolve(previewDirectory);
      for (const file of generatedPreviewFiles) {
        const resolved = path.resolve(file);
        if (!resolved.startsWith(`${previewRoot}${path.sep}`) || !(await isUsablePreview(file))) {
          throw new Error('The renderer returned an invalid landing preview segment.');
        }
      }
      const relativeFiles = generatedPreviewFiles.map(file => path.relative(this.root, file));
      obsoletePreviewFiles = previewFilesOf(landing).filter(file => !relativeFiles.includes(file));
      landing.previewFile = relativeFiles[0];
      landing.previewFiles = relativeFiles;
      landing.previewAvailable = true;
      landing.previewWidth = result.width;
      landing.previewHeight = result.height;
      landing.blockedExternalRequests = result.blockedExternalRequests;
      landing.warning = result.warning;
      landing.renderedAt = Date.now();
      landing.status = 'ready';
      landing.stale = false;
      landing.error = null;
      landing.renderProfile = this.renderProfile();
      generatedPreviewFiles = [];
    } catch (error) {
      await Promise.all(
        generatedPreviewFiles.map(file => rm(file, { force: true }).catch(() => {}))
      );
      if (signal.aborted) {
        landing.status = 'queued';
        throw error;
      }
      landing.status = 'failed';
      landing.error = errorMessage(error);
    }
    this.progress.completed += 1;
    await this.persist();
    await Promise.all(
      obsoletePreviewFiles.map(file => {
        const target = safeCachePath(this.root, file);
        return target ? rm(target, { force: true }).catch(() => {}) : Promise.resolve();
      })
    );
    this.notify('landing-preview:progress');
  }

  private async prepareLanding(
    catalog: StoredCatalog,
    landing: StoredLanding,
    signal: AbortSignal
  ) {
    const source = safeSourcePath(catalog.rootPath, landing.sourceRelativePath);
    if (!source) throw new Error('Landing source path is invalid.');
    if (landing.sourceKind === 'folder') {
      const root = await realpath(source);
      return { root, entryFile: landing.entryFile };
    }
    const content = this.archiveContentPath(catalog, landing);
    await this.ensureArchiveExtracted(source, content, landing.fingerprint, signal);
    landing.extractedAvailable = true;
    const root = landing.archiveRoot
      ? path.join(content, ...landing.archiveRoot.split('/'))
      : content;
    return { root: await realpath(root), entryFile: landing.entryFile };
  }

  /**
   * Extracts an archive at most once even when concurrent workers request the
   * same ZIP (multiple landing roots inside one archive share this directory).
   */
  private ensureArchiveExtracted(
    source: string,
    content: string,
    fingerprint: string,
    signal: AbortSignal
  ): Promise<void> {
    const archiveDirectory = path.dirname(content);
    const existing = this.archiveWork.get(archiveDirectory);
    if (existing) return existing;
    const work = (async () => {
      const completeMarker = path.join(archiveDirectory, 'complete.json');
      if ((await exists(completeMarker)) && (await exists(content))) return;
      const staging = `${archiveDirectory}.installing-${randomUUID()}`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      try {
        await extractZipSafely(source, path.join(staging, 'content'), signal);
        await writeFile(
          path.join(staging, 'complete.json'),
          `${JSON.stringify({ fingerprint })}\n`,
          'utf8'
        );
        await rm(archiveDirectory, { recursive: true, force: true });
        await mkdir(path.dirname(archiveDirectory), { recursive: true });
        await rename(staging, archiveDirectory);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    })().finally(() => {
      this.archiveWork.delete(archiveDirectory);
    });
    this.archiveWork.set(archiveDirectory, work);
    return work;
  }

  private archiveContentPath(catalog: StoredCatalog, landing: StoredLanding) {
    const archiveKey = digest(`${landing.sourceRelativePath}\0${landing.fingerprint}`).slice(0, 24);
    return path.join(this.catalogCacheRoot(catalog), 'archives', archiveKey, 'content');
  }

  private catalogCacheRoot(catalog: StoredCatalog) {
    return path.join(this.root, 'catalogs', catalog.id);
  }

  private async cleanupUnusedArchiveCache(catalog: StoredCatalog) {
    const archivesRoot = path.join(this.catalogCacheRoot(catalog), 'archives');
    const retained = new Set(
      catalog.landings
        .filter(item => item.sourceKind === 'zip')
        .map(item => path.basename(path.dirname(this.archiveContentPath(catalog, item))))
    );
    let entries;
    try {
      entries = await readdir(archivesRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(entry =>
        retained.has(entry.name)
          ? Promise.resolve()
          : rm(path.join(archivesRoot, entry.name), { recursive: true, force: true })
      )
    );
  }

  private activeCatalog() {
    return this.catalogs.find(item => item.id === this.activeCatalogId) ?? null;
  }

  private async revalidateCachedPreviews() {
    for (const catalog of this.catalogs) {
      catalog.sourceAvailable = await exists(catalog.rootPath);
      for (const landing of catalog.landings) {
        const previews = previewFilesOf(landing);
        if (!(await previewFilesUsable(this.root, previews))) {
          landing.previewFile = null;
          landing.previewFiles = [];
          landing.previewAvailable = false;
          landing.previewWidth = null;
          landing.previewHeight = null;
          landing.renderedAt = null;
          landing.status = landing.status === 'failed' ? 'failed' : 'queued';
        } else if (landing.status === 'rendering') {
          landing.status = 'ready';
        }
        if (landing.previewAvailable && landing.renderProfile !== this.renderProfile()) {
          landing.status = 'queued';
          landing.stale = true;
        }
        if (landing.sourceKind === 'zip') {
          const content = this.archiveContentPath(catalog, landing);
          landing.extractedAvailable =
            (await exists(content)) &&
            (await exists(path.join(path.dirname(content), 'complete.json')));
        } else {
          landing.extractedAvailable = false;
        }
      }
    }
    await this.persist();
  }

  private persist() {
    const snapshot: StoredState = structuredClone({
      version: STATE_VERSION,
      activeCatalogId: this.activeCatalogId,
      catalogs: this.catalogs,
      settings: this.settings
    });
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        await mkdir(this.root, { recursive: true });
        const temporary = `${this.statePath}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        await rename(temporary, this.statePath);
      });
    return this.saveChain;
  }
}

function reconcileLanding(
  catalogId: string,
  discovered: DiscoveredLanding,
  old: StoredLanding | undefined,
  options: { reusePreview: boolean; keepOldPreview: boolean; renderProfile: string }
): StoredLanding {
  const id = old?.id ?? `preview_${digest(`${catalogId}\0${discovered.key}`).slice(0, 24)}`;
  const oldPreviewFiles = old ? previewFilesOf(old) : [];
  const previewAvailable = options.keepOldPreview && oldPreviewFiles.length > 0;
  const sameSource = old?.fingerprint === discovered.fingerprint;
  return {
    id,
    key: discovered.key,
    fingerprint: discovered.fingerprint,
    renderProfile: old?.renderProfile ?? options.renderProfile,
    entryFile: discovered.entryFile,
    name: discovered.name,
    relativePath: discovered.relativePath,
    sourceKind: discovered.sourceKind,
    sourceRelativePath: discovered.sourceRelativePath,
    archiveRoot: discovered.archiveRoot,
    extractedAvailable:
      discovered.sourceKind === 'zip' && sameSource ? (old?.extractedAvailable ?? false) : false,
    status: options.reusePreview ? 'ready' : 'queued',
    stale: previewAvailable && !options.reusePreview,
    previewAvailable,
    previewFile: previewAvailable ? oldPreviewFiles[0] : null,
    previewFiles: previewAvailable ? oldPreviewFiles : [],
    previewWidth: previewAvailable ? (old?.previewWidth ?? null) : null,
    previewHeight: previewAvailable ? (old?.previewHeight ?? null) : null,
    renderedAt: previewAvailable ? (old?.renderedAt ?? null) : null,
    blockedExternalRequests: previewAvailable ? (old?.blockedExternalRequests ?? 0) : 0,
    warning: previewAvailable ? (old?.warning ?? null) : null,
    error: null
  };
}

function publicLanding(landing: StoredLanding): LandingPreviewItem {
  return {
    id: landing.id,
    name: landing.name,
    relativePath: landing.relativePath,
    sourceKind: landing.sourceKind,
    sourceRelativePath: landing.sourceRelativePath,
    archiveRoot: landing.archiveRoot,
    extractedAvailable: landing.extractedAvailable,
    status: landing.status,
    stale: landing.stale,
    previewAvailable: landing.previewAvailable,
    previewWidth: landing.previewWidth,
    previewHeight: landing.previewHeight,
    previewSegments: Math.max(1, previewFilesOf(landing).length),
    renderedAt: landing.renderedAt,
    blockedExternalRequests: landing.blockedExternalRequests,
    warning: landing.warning,
    error: landing.error
  };
}

function normalizeCatalog(value: StoredCatalog): StoredCatalog | null {
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.rootPath !== 'string' ||
    !Array.isArray(value.landings)
  ) {
    return null;
  }
  return {
    ...value,
    sourceAvailable: value.sourceAvailable !== false,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter(item => typeof item === 'string')
      : [],
    landings: value.landings
      .filter(item => item && typeof item.id === 'string')
      .map(item => ({
        ...item,
        previewFiles: Array.isArray(item.previewFiles)
          ? item.previewFiles.filter(file => typeof file === 'string')
          : item.previewFile
            ? [item.previewFile]
            : [],
        extractedAvailable: item.extractedAvailable === true
      }))
  };
}

function safeSourcePath(root: string, relative: string) {
  const target = path.resolve(root, ...relative.split('/').filter(Boolean));
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
}

function emptyProgress(): LandingPreviewState['progress'] {
  return { phase: 'idle', completed: 0, total: 0, currentLandingId: null };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function previewFilesOf(landing: Pick<StoredLanding, 'previewFile' | 'previewFiles'>) {
  const files = Array.isArray(landing.previewFiles)
    ? landing.previewFiles.filter(file => typeof file === 'string' && file.length > 0)
    : [];
  if (!files.length && landing.previewFile) files.push(landing.previewFile);
  return [...new Set(files)];
}

async function previewFilesUsable(root: string, files: string[]) {
  return (
    files.length > 0 &&
    (
      await Promise.all(
        files.map(file => {
          const target = safeCachePath(root, file);
          return target ? isUsablePreview(target) : Promise.resolve(false);
        })
      )
    ).every(Boolean)
  );
}

function safeCachePath(root: string, relative: string) {
  const target = path.resolve(root, relative);
  return target.startsWith(`${path.resolve(root)}${path.sep}`) ? target : null;
}

async function isUsablePreview(target: string) {
  try {
    const handle = await openFile(target, 'r');
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size < 32) return false;
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return (
        bytesRead === header.length &&
        header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP'
      );
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Landing preview failed.';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}
