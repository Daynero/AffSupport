import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import type {
  LandingPreviewEventType,
  LandingPreviewItem,
  LandingPreviewState
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { extractZipSafely } from './archive.js';
import { LandingPageRenderer, type LandingRenderResult } from './renderer.js';
import { discoverLandings, type DiscoveredLanding } from './scanner.js';

const STATE_VERSION = 1;
const RENDER_PROFILE = 'desktop-1440x900-v1';
const MAX_VISIBLE_WARNINGS = 8;

interface StoredLanding extends LandingPreviewItem {
  key: string;
  fingerprint: string;
  renderProfile: string;
  entryFile: string;
  previewFile: string | null;
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
}

export interface LandingRenderer {
  init(): Promise<void>;
  availability(): { available: boolean; error: string | null };
  render(input: {
    root: string;
    entryFile: string;
    outputPath: string;
    signal?: AbortSignal;
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
  private notify: (type?: LandingPreviewEventType) => void = () => {};
  private progress: LandingPreviewState['progress'] = emptyProgress();
  private running = false;
  private error: string | null = null;

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
      warnings: [...(active?.warnings ?? [])],
      error: this.error,
      updatedAt: active?.updatedAt ?? null
    };
  }

  busy() {
    return this.running;
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

  async previewPath(landingId: string): Promise<string | null> {
    const landing = this.activeCatalog()?.landings.find(item => item.id === landingId);
    if (!landing?.previewAvailable || !landing.previewFile) return null;
    const candidate = path.join(this.root, landing.previewFile);
    return (await exists(candidate)) ? candidate : null;
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
      const previewStillExists = old?.previewFile
        ? await exists(path.join(this.root, old.previewFile))
        : false;
      const unchanged =
        Boolean(old) &&
        old!.fingerprint === discovered.fingerprint &&
        old!.renderProfile === RENDER_PROFILE &&
        previewStillExists;
      const forced = mode === 'all' || (mode === 'current' && old?.id === landingId);
      next.push(
        reconcileLanding(catalog.id, discovered, old, {
          reusePreview: unchanged && !forced,
          keepOldPreview: previewStillExists
        })
      );
    }
    catalog.landings = next;
    catalog.updatedAt = Date.now();
    await this.cleanupUnusedArchiveCache(catalog);
    for (const removed of previous.values()) {
      if (removed.previewFile) {
        await rm(path.join(this.root, removed.previewFile), { force: true }).catch(() => {});
      }
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
    for (const landing of queued) {
      throwIfAborted(signal);
      this.progress.currentLandingId = landing.id;
      landing.status = 'rendering';
      landing.error = null;
      this.progress.phase = landing.sourceKind === 'zip' ? 'extracting' : 'rendering';
      this.notify('landing-preview:progress');
      try {
        const prepared = await this.prepareLanding(catalog, landing, signal);
        throwIfAborted(signal);
        this.progress.phase = 'rendering';
        this.notify('landing-preview:progress');
        const previewDirectory = path.join(this.catalogCacheRoot(catalog), 'previews');
        await mkdir(previewDirectory, { recursive: true });
        const finalPath = path.join(previewDirectory, `${landing.id}.webp`);
        const temporaryPath = path.join(previewDirectory, `${landing.id}.${randomUUID()}.tmp.webp`);
        try {
          const result = await this.renderer.render({
            root: prepared.root,
            entryFile: prepared.entryFile,
            outputPath: temporaryPath,
            signal
          });
          await rename(temporaryPath, finalPath);
          landing.previewFile = path.relative(this.root, finalPath);
          landing.previewAvailable = true;
          landing.previewWidth = result.width;
          landing.previewHeight = result.height;
          landing.blockedExternalRequests = result.blockedExternalRequests;
          landing.warning = result.warning;
          landing.renderedAt = Date.now();
          landing.status = 'ready';
          landing.stale = false;
          landing.error = null;
          landing.renderProfile = RENDER_PROFILE;
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => {});
        }
      } catch (error) {
        if (signal.aborted) {
          landing.status = 'queued';
          throw error;
        }
        landing.status = 'failed';
        landing.error = errorMessage(error);
      }
      this.progress.completed += 1;
      await this.persist();
      this.notify('landing-preview:progress');
    }
    this.progress.currentLandingId = null;
    this.progress.phase = 'completed';
    catalog.updatedAt = Date.now();
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
    const completeMarker = path.join(path.dirname(content), 'complete.json');
    if (!(await exists(completeMarker)) || !(await exists(content))) {
      const archiveDirectory = path.dirname(content);
      const staging = `${archiveDirectory}.installing-${randomUUID()}`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      try {
        await extractZipSafely(source, path.join(staging, 'content'), signal);
        await writeFile(
          path.join(staging, 'complete.json'),
          `${JSON.stringify({ fingerprint: landing.fingerprint })}\n`,
          'utf8'
        );
        await rm(archiveDirectory, { recursive: true, force: true });
        await mkdir(path.dirname(archiveDirectory), { recursive: true });
        await rename(staging, archiveDirectory);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }
    landing.extractedAvailable = true;
    const root = landing.archiveRoot
      ? path.join(content, ...landing.archiveRoot.split('/'))
      : content;
    return { root: await realpath(root), entryFile: landing.entryFile };
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
        if (!landing.previewFile || !(await exists(path.join(this.root, landing.previewFile)))) {
          landing.previewFile = null;
          landing.previewAvailable = false;
          landing.previewWidth = null;
          landing.previewHeight = null;
          landing.renderedAt = null;
          landing.status = landing.status === 'failed' ? 'failed' : 'queued';
        } else if (landing.status === 'rendering') {
          landing.status = 'ready';
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
      catalogs: this.catalogs
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
  options: { reusePreview: boolean; keepOldPreview: boolean }
): StoredLanding {
  const id = old?.id ?? `preview_${digest(`${catalogId}\0${discovered.key}`).slice(0, 24)}`;
  const previewAvailable = options.keepOldPreview && Boolean(old?.previewFile);
  const sameSource = old?.fingerprint === discovered.fingerprint;
  return {
    id,
    key: discovered.key,
    fingerprint: discovered.fingerprint,
    renderProfile: old?.renderProfile ?? RENDER_PROFILE,
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
    previewFile: previewAvailable ? (old?.previewFile ?? null) : null,
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
      .map(item => ({ ...item, extractedAvailable: item.extractedAvailable === true }))
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Landing preview failed.';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}
