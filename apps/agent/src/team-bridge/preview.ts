import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { TeamPreviewUnavailableReason, TeamTransferGrant } from '@video-compressor/shared';
import {
  extractZipSafely,
  inspectZip,
  type SafeZipEntry,
  type ZipInspection
} from '../landing-preview/archive.js';
import { LandingPageRenderer, type LandingRenderResult } from '../landing-preview/renderer.js';
import {
  LandingPreviewOrigin,
  createLandingValidationRecord,
  type LandingValidationRecord
} from './preview-origin.js';
import { applicationSupportRoot } from '../files/support-dir.js';

const MAX_RANGE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Where an opened landing is kept once it has been unpacked and captured.
 *
 * Opening a landing used to cost the same every time: download the whole
 * package again, unpack it again, and drive Chromium over it again — for a
 * file nobody had changed. Which is why looking at three landings in a row
 * felt like rendering three landings in a row. The unpacked page and its
 * fallback stills are kept under this directory instead, keyed by what the
 * relay says the source *is*, so a second look is a directory read.
 */
const LANDING_CACHE_DIRNAME = 'wishly-landing-preview-cache';
/** Bumped when unpacking or the fallback capture changes shape. */
const LANDING_CACHE_VERSION = 'v1';
/** How many landings stay unpacked. The least recently opened go first. */
const LANDING_CACHE_ENTRIES = 8;

export interface TeamPreviewTransferRequest {
  operationId: string;
  transferUrl: string;
  transferGrant: TeamTransferGrant;
}

export interface TeamArchiveManifestEntry {
  path: string;
  directory: boolean;
  sizeBytes: number;
}

export type TeamArchivePreviewResponse =
  | {
      kind: 'archive';
      operationId: string;
      entries: TeamArchiveManifestEntry[];
      truncated: false;
    }
  | {
      kind: 'unavailable';
      operationId: string;
      reason: TeamPreviewUnavailableReason;
    };

export type TeamLandingPreviewResponse =
  | {
      kind: 'landing';
      operationId: string;
      url: string;
      sandbox: 'allow-scripts';
      warning: 'external_navigation_blocked' | null;
      screenshotAvailable: boolean;
      validation: LandingValidationRecord;
    }
  | {
      kind: 'unavailable';
      operationId: string;
      reason: TeamPreviewUnavailableReason;
    };

interface DownloadedPreview {
  file: string;
  workspace: string;
  sourceVersion: string | null;
  sourceChecksum: string | null;
}

interface LandingSession {
  /** Null when the page is being served out of the cache, which outlives it. */
  workspace: string | null;
  screenshotFiles: string[];
}

/** What a cached landing needs to be served again without the source. */
interface LandingCacheManifest {
  version: string;
  entryFile: string;
  /** File names under `shots/`, in segment order. */
  screenshots: string[];
  validation: LandingValidationRecord;
}

interface CachedLanding {
  root: string;
  entryFile: string;
  screenshotFiles: string[];
  validation: LandingValidationRecord;
}

export interface TeamPreviewBridgeOptions {
  fetchImpl?: typeof fetch;
  temporaryRoot?: string;
  /**
   * Where unpacked landings are kept between opens. Defaults to the user's own
   * Soty directory rather than the system temp: a cache the operating system
   * empties on a whim is a cache that answers "no" every Monday morning.
   */
  cacheRoot?: string;
  origin?: LandingPreviewOrigin;
  renderer?: Pick<LandingPageRenderer, 'init' | 'availability' | 'render' | 'shutdown'>;
}

export class TeamPreviewBridge {
  readonly #fetch: typeof fetch;
  readonly #temporaryRoot: string;
  readonly #cacheRootPath: string;
  readonly #origin: LandingPreviewOrigin;
  readonly #renderer: Pick<LandingPageRenderer, 'init' | 'availability' | 'render' | 'shutdown'>;
  readonly #controllers = new Map<string, AbortController>();
  readonly #landingSessions = new Map<string, LandingSession>();
  #initialized = false;

  constructor(options: TeamPreviewBridgeOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    this.#cacheRootPath =
      options.cacheRoot ??
      (options.temporaryRoot
        ? path.join(options.temporaryRoot, LANDING_CACHE_DIRNAME)
        : path.join(applicationSupportRoot(), LANDING_CACHE_DIRNAME));
    this.#origin = options.origin ?? new LandingPreviewOrigin();
    this.#renderer = options.renderer ?? new LandingPageRenderer();
  }

  async init() {
    if (this.#initialized) return;
    await mkdir(this.#temporaryRoot, { recursive: true });
    await this.#renderer.init();
    this.#initialized = true;
  }

  busy() {
    return this.#controllers.size > 0 || this.#landingSessions.size > 0 || this.#origin.busy();
  }

  async previewArchive(request: TeamPreviewTransferRequest): Promise<TeamArchivePreviewResponse> {
    const controller = this.#begin(request.operationId);
    let downloaded: DownloadedPreview | null = null;
    try {
      downloaded = await this.#download(request, controller.signal);
      const inspection = await inspectZip(downloaded.file, controller.signal);
      return {
        kind: 'archive',
        operationId: request.operationId,
        entries: inspection.entries.map(manifestEntry),
        truncated: false
      };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      return {
        kind: 'unavailable',
        operationId: request.operationId,
        reason: classifyArchivePreviewError(error)
      };
    } finally {
      this.#controllers.delete(request.operationId);
      if (downloaded) await rm(downloaded.workspace, { recursive: true, force: true });
    }
  }

  async previewLanding(request: TeamPreviewTransferRequest): Promise<TeamLandingPreviewResponse> {
    const controller = this.#begin(request.operationId);
    let downloaded: DownloadedPreview | null = null;
    let promotedToSession = false;
    try {
      /*
       * One byte before five hundred megabytes: the relay answers a `0-0`
       * range with the source's version and checksum, which is the whole key
       * to whether the copy on disk is still this file. A hit here means the
       * package is never downloaded at all.
       */
      const peeked = await this.#peekIdentity(request, controller.signal);
      const peekedKey = peeked && landingCacheKey(peeked.version, peeked.checksum);
      if (peekedKey) {
        const cached = await this.#readCachedLanding(peekedKey);
        if (cached) return await this.#serveCachedLanding(request.operationId, cached);
      }
      downloaded = await this.#download(request, controller.signal);
      const cacheKey =
        peekedKey ?? landingCacheKey(downloaded.sourceVersion, downloaded.sourceChecksum);
      if (cacheKey && !peekedKey) {
        // The relay did not answer the cheap probe, but the download itself
        // carries the same identity: the unpacking and the capture are still
        // saved, which is the expensive half.
        const cached = await this.#readCachedLanding(cacheKey);
        if (cached) return await this.#serveCachedLanding(request.operationId, cached);
      }
      const extracted = path.join(downloaded.workspace, 'extracted');
      /* A landing is normally a package, but the catalog also calls a bare
         .html file a landing — that is what its type says it is. Rendering
         only ever unpacked a ZIP, so those files failed as "corrupt" every
         time, in the viewer and in the background render alike. A single page
         is written out as the package it stands for and follows the same path
         from here on. */
      const single = await singlePageLanding(downloaded.file, extracted);
      const inspection = single ?? (await inspectZip(downloaded.file, controller.signal));
      const landingRoot = inspection.landingRoots[0];
      if (landingRoot === undefined) {
        return {
          kind: 'unavailable',
          operationId: request.operationId,
          reason: 'unsupported'
        };
      }
      if (!single) await extractZipSafely(downloaded.file, extracted, controller.signal);
      const entry = landingEntry(inspection, landingRoot);
      if (!entry) throw new Error('INVALID_ARCHIVE');
      const landingDirectory = path.join(extracted, ...landingRoot.split('/').filter(Boolean));
      const validation = createLandingValidationRecord({
        sourceVersion: downloaded.sourceVersion,
        sourceChecksum: downloaded.sourceChecksum,
        entries: inspection.entries,
        landingRoot
      });
      const screenshotFiles = await this.#renderFallback({
        root: landingDirectory,
        entryFile: path.posix.basename(entry.path),
        outputPath: path.join(downloaded.workspace, 'fallback.webp'),
        signal: controller.signal
      });
      const entryFile = path.posix.basename(entry.path);
      /*
       * Kept, if the source said what it is. The unpacked page moves into the
       * cache rather than being copied there — same filesystem, one rename —
       * and the workspace goes with the download that made it.
       */
      const stored = cacheKey
        ? await this.#storeCachedLanding(cacheKey, {
            landingDirectory,
            entryFile,
            screenshotFiles,
            validation
          })
        : null;
      if (stored) {
        const response = await this.#serveCachedLanding(request.operationId, stored);
        await rm(downloaded.workspace, { recursive: true, force: true }).catch(() => undefined);
        downloaded = null;
        return response;
      }
      const origin = await this.#origin.open({
        operationId: request.operationId,
        root: landingDirectory,
        entryFile,
        removePathOnClose: downloaded.workspace
      });
      this.#landingSessions.set(request.operationId, {
        workspace: downloaded.workspace,
        screenshotFiles
      });
      promotedToSession = true;
      return {
        kind: 'landing',
        operationId: request.operationId,
        url: origin.url,
        sandbox: origin.sandbox,
        warning: 'external_navigation_blocked',
        screenshotAvailable: screenshotFiles.length > 0,
        validation
      };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      return {
        kind: 'unavailable',
        operationId: request.operationId,
        reason: classifyArchivePreviewError(error)
      };
    } finally {
      this.#controllers.delete(request.operationId);
      if (downloaded && !promotedToSession) {
        await rm(downloaded.workspace, { recursive: true, force: true });
      }
    }
  }

  screenshotPath(operationId: string, segment: number): string | null {
    const session = this.#landingSessions.get(operationId);
    return session?.screenshotFiles[segment] ?? null;
  }

  async close(operationId: string): Promise<boolean> {
    const controller = this.#controllers.get(operationId);
    if (controller) controller.abort(new Error('PREVIEW_CANCELED'));
    this.#controllers.delete(operationId);
    const session = this.#landingSessions.get(operationId);
    this.#landingSessions.delete(operationId);
    const originClosed = await this.#origin.close(operationId);
    // A cached landing has no workspace of its own: closing the viewer must
    // not take the unpacked copy with it, or the next open pays for it again.
    if (session?.workspace && !originClosed) {
      await rm(session.workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    return Boolean(controller || session || originClosed);
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#controllers.values()) {
      controller.abort(new Error('PREVIEW_CANCELED'));
    }
    const operationIds = new Set([...this.#controllers.keys(), ...this.#landingSessions.keys()]);
    await Promise.all([...operationIds].map(operationId => this.close(operationId)));
    await this.#origin.shutdown();
    await this.#renderer.shutdown();
    this.#initialized = false;
  }

  #begin(operationId: string): AbortController {
    if (!this.#initialized) throw new Error('PREVIEW_BRIDGE_NOT_INITIALIZED');
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) throw new Error('INVALID_INPUT');
    if (this.#controllers.has(operationId) || this.#landingSessions.has(operationId)) {
      throw new Error('WRONG_STATE');
    }
    const controller = new AbortController();
    this.#controllers.set(operationId, controller);
    return controller;
  }

  async #download(
    request: TeamPreviewTransferRequest,
    signal: AbortSignal
  ): Promise<DownloadedPreview> {
    validateTransferRequest(request);
    const workspace = await mkdtemp(path.join(this.#temporaryRoot, 'wishly-team-preview-'));
    const file = path.join(workspace, 'source.zip');
    const handle = await open(file, 'wx', 0o600);
    let offset = 0;
    let totalBytes: number | null = null;
    let sourceVersion: string | null = null;
    let sourceChecksum: string | null = null;
    try {
      while (totalBytes === null || offset < totalBytes) {
        throwIfAborted(signal);
        const end = Math.min(
          offset + request.transferGrant.maxRangeBytes - 1,
          MAX_ARCHIVE_DOWNLOAD_BYTES - 1
        );
        if (end < offset) throw new Error('TOO_LARGE');
        const url = new URL(request.transferUrl);
        url.searchParams.set('grant', request.transferGrant.ticket);
        const response = await this.#fetch(url, {
          method: 'GET',
          headers: { range: `bytes=${offset}-${end}` },
          cache: 'no-store',
          redirect: 'error',
          signal
        });
        if (response.status !== 200 && response.status !== 206) {
          const code = await safeErrorCode(response);
          throw new Error(code);
        }
        const identity = {
          version: response.headers.get('x-wishly-source-version'),
          checksum: response.headers.get('x-wishly-source-checksum')
        };
        if (offset === 0) {
          sourceVersion = identity.version;
          sourceChecksum = identity.checksum;
        } else if (sourceVersion !== identity.version || sourceChecksum !== identity.checksum) {
          throw new Error('SOURCE_CHANGED');
        }
        const range = response.headers.get('content-range');
        const rangeMatch = range ? /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range) : null;
        const contentLength = numericHeader(response.headers.get('content-length'));
        if (response.status === 206) {
          if (!rangeMatch || Number(rangeMatch[1]) !== offset) throw new Error('INVALID_RESPONSE');
          const responseEnd = Number(rangeMatch[2]);
          totalBytes = Number(rangeMatch[3]);
          if (
            !Number.isSafeInteger(responseEnd) ||
            !Number.isSafeInteger(totalBytes) ||
            responseEnd < offset ||
            responseEnd > end ||
            totalBytes <= responseEnd ||
            totalBytes > MAX_ARCHIVE_DOWNLOAD_BYTES ||
            contentLength !== responseEnd - offset + 1
          ) {
            throw new Error(
              totalBytes > MAX_ARCHIVE_DOWNLOAD_BYTES ? 'TOO_LARGE' : 'INVALID_RESPONSE'
            );
          }
        } else {
          if (
            offset !== 0 ||
            contentLength === null ||
            contentLength > request.transferGrant.maxRangeBytes
          ) {
            throw new Error('INVALID_RESPONSE');
          }
          totalBytes = contentLength;
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('INVALID_RESPONSE');
        let responseBytes = 0;
        while (true) {
          throwIfAborted(signal);
          const { value, done } = await reader.read();
          if (done) break;
          responseBytes += value.byteLength;
          if (
            responseBytes > request.transferGrant.maxRangeBytes ||
            offset + responseBytes > MAX_ARCHIVE_DOWNLOAD_BYTES ||
            (contentLength !== null && responseBytes > contentLength)
          ) {
            await reader.cancel();
            throw new Error('TOO_LARGE');
          }
          await handle.write(value, 0, value.byteLength, offset + responseBytes - value.byteLength);
        }
        if (contentLength === null || responseBytes !== contentLength || responseBytes === 0) {
          throw new Error('INVALID_RESPONSE');
        }
        offset += responseBytes;
      }
      if (offset !== totalBytes || offset === 0) throw new Error('INVALID_RESPONSE');
      return { file, workspace, sourceVersion, sourceChecksum };
    } catch (error) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * What the relay says the source is, for one byte of it.
   *
   * Everything here is best-effort: a relay that refuses the probe, or answers
   * without the identity headers, simply means the download decides — never a
   * failed preview.
   */
  async #peekIdentity(
    request: TeamPreviewTransferRequest,
    signal: AbortSignal
  ): Promise<{ version: string | null; checksum: string | null } | null> {
    try {
      validateTransferRequest(request);
      const url = new URL(request.transferUrl);
      url.searchParams.set('grant', request.transferGrant.ticket);
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { range: 'bytes=0-0' },
        cache: 'no-store',
        redirect: 'error',
        signal
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 206 && response.status !== 200) return null;
      return {
        version: response.headers.get('x-wishly-source-version'),
        checksum: response.headers.get('x-wishly-source-checksum')
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return null;
    }
  }

  #cacheRoot(): string {
    return this.#cacheRootPath;
  }

  /** The unpacked page for this key, if it is still whole. */
  async #readCachedLanding(key: string): Promise<CachedLanding | null> {
    const directory = path.join(this.#cacheRoot(), key);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, 'manifest.json'), 'utf8')
      ) as Partial<LandingCacheManifest>;
      if (
        manifest.version !== LANDING_CACHE_VERSION ||
        typeof manifest.entryFile !== 'string' ||
        !Array.isArray(manifest.screenshots) ||
        !manifest.screenshots.every(name => typeof name === 'string') ||
        !manifest.validation
      ) {
        return null;
      }
      const root = path.join(directory, 'landing');
      // The entry file is what the origin will serve; without it the rest is
      // an empty directory pretending to be a landing.
      await stat(path.join(root, manifest.entryFile));
      const screenshotFiles: string[] = [];
      for (const name of manifest.screenshots) {
        const file = path.join(directory, 'shots', path.basename(name));
        try {
          await stat(file);
          screenshotFiles.push(file);
        } catch {
          break;
        }
      }
      // Touched so the trim below reads "least recently opened", not "oldest".
      await writeFile(path.join(directory, 'used'), String(Date.now()), 'utf8').catch(
        () => undefined
      );
      return {
        root,
        entryFile: manifest.entryFile,
        screenshotFiles,
        validation: manifest.validation
      };
    } catch {
      return null;
    }
  }

  /** Moves an unpacked landing into the cache, and returns it as one. */
  async #storeCachedLanding(
    key: string,
    input: {
      landingDirectory: string;
      entryFile: string;
      screenshotFiles: string[];
      validation: LandingValidationRecord;
    }
  ): Promise<CachedLanding | null> {
    const directory = path.join(this.#cacheRoot(), key);
    try {
      await rm(directory, { recursive: true, force: true });
      await mkdir(path.join(directory, 'shots'), { recursive: true });
      await rename(input.landingDirectory, path.join(directory, 'landing'));
      const screenshots: string[] = [];
      const screenshotFiles: string[] = [];
      for (const [index, file] of input.screenshotFiles.entries()) {
        const name = `segment-${String(index).padStart(3, '0')}${path.extname(file) || '.webp'}`;
        const target = path.join(directory, 'shots', name);
        await rename(file, target);
        screenshots.push(name);
        screenshotFiles.push(target);
      }
      const manifest: LandingCacheManifest = {
        version: LANDING_CACHE_VERSION,
        entryFile: input.entryFile,
        screenshots,
        validation: input.validation
      };
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
      await this.#trimCache();
      return {
        root: path.join(directory, 'landing'),
        entryFile: input.entryFile,
        screenshotFiles,
        validation: input.validation
      };
    } catch {
      // A cache that cannot be written is not a preview that cannot be shown:
      // the caller falls back to serving out of the workspace it already has.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return null;
    }
  }

  /** Opens a cached landing as this operation's origin. Nothing is deleted on close. */
  async #serveCachedLanding(
    operationId: string,
    cached: CachedLanding
  ): Promise<TeamLandingPreviewResponse> {
    const origin = await this.#origin.open({
      operationId,
      root: cached.root,
      entryFile: cached.entryFile
    });
    this.#landingSessions.set(operationId, {
      workspace: null,
      screenshotFiles: cached.screenshotFiles
    });
    return {
      kind: 'landing',
      operationId,
      url: origin.url,
      sandbox: origin.sandbox,
      warning: 'external_navigation_blocked',
      screenshotAvailable: cached.screenshotFiles.length > 0,
      validation: cached.validation
    };
  }

  /** Keeps the newest few and drops the rest, oldest use first. */
  async #trimCache(): Promise<void> {
    const root = this.#cacheRoot();
    try {
      const names = await readdir(root);
      if (names.length <= LANDING_CACHE_ENTRIES) return;
      const entries: Array<{ name: string; usedAt: number }> = [];
      for (const name of names) {
        try {
          const used = await stat(path.join(root, name, 'used'));
          entries.push({ name, usedAt: used.mtimeMs });
        } catch {
          const directory = await stat(path.join(root, name));
          entries.push({ name, usedAt: directory.mtimeMs });
        }
      }
      entries.sort((left, right) => right.usedAt - left.usedAt);
      for (const stale of entries.slice(LANDING_CACHE_ENTRIES)) {
        await rm(path.join(root, stale.name), { recursive: true, force: true }).catch(
          () => undefined
        );
      }
    } catch {
      // Nothing cached yet, or a directory this process may not read.
    }
  }

  async #renderFallback(input: {
    root: string;
    entryFile: string;
    outputPath: string;
    signal: AbortSignal;
  }): Promise<string[]> {
    if (!this.#renderer.availability().available) return [];
    try {
      const rendered: LandingRenderResult = await this.#renderer.render(input);
      return rendered.segmentFiles;
    } catch {
      return [];
    }
  }
}

/**
 * What identifies a landing on disk: its checksum, and the version beside it.
 *
 * The checksum is required — a version alone is a per-file counter ("2" on
 * everything), so keying on it would serve one landing's page for another.
 */
function landingCacheKey(version: string | null, checksum: string | null): string | null {
  if (!checksum) return null;
  return createHash('sha256')
    .update(`${LANDING_CACHE_VERSION}\0${version ?? ''}\0${checksum}`)
    .digest('hex')
    .slice(0, 32);
}

function manifestEntry(entry: SafeZipEntry): TeamArchiveManifestEntry {
  return {
    path: entry.path,
    directory: entry.directory,
    sizeBytes: entry.uncompressedSize
  };
}

/** The first four bytes of every ZIP local file header. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** A page written out on its own is a document, not an archive of one. */
const MAX_SINGLE_PAGE_BYTES = 8 * 1024 * 1024;
const HTML_MARKER = /<(?:!doctype\s+html|html|head|body|meta|title)\b/iu;

/**
 * Materialises a standalone HTML file as a one-entry landing package.
 *
 * Returns null for anything that is a ZIP, is too large to be a page, or does
 * not read as HTML — those go on to the archive path unchanged, so a broken
 * ZIP still reports itself as a broken ZIP rather than as an unsupported page.
 */
async function singlePageLanding(file: string, extracted: string): Promise<ZipInspection | null> {
  const handle = await open(file, 'r');
  let head: Buffer;
  let size: number;
  try {
    const status = await handle.stat();
    size = status.size;
    head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }
  if (size < 1 || size > MAX_SINGLE_PAGE_BYTES || head.equals(ZIP_MAGIC)) return null;
  const bytes = await readFile(file);
  if (!HTML_MARKER.test(bytes.subarray(0, 4096).toString('utf8'))) return null;
  await mkdir(extracted, { recursive: true });
  await writeFile(path.join(extracted, 'index.html'), bytes);
  const entry: SafeZipEntry = {
    path: 'index.html',
    directory: false,
    compressedSize: bytes.byteLength,
    uncompressedSize: bytes.byteLength,
    crc32: 0
  };
  return {
    entries: [entry],
    landingRoots: [''],
    compressedBytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength
  };
}

function landingEntry(inspection: ZipInspection, root: string) {
  return inspection.entries.find(entry => {
    if (entry.directory || !/^index\.html?$/iu.test(path.posix.basename(entry.path))) return false;
    const directory = path.posix.dirname(entry.path);
    return (directory === '.' ? '' : directory) === root;
  });
}

function validateTransferRequest(request: TeamPreviewTransferRequest) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(request.operationId)) throw new Error('INVALID_INPUT');
  if (
    request.transferGrant.purpose !== 'preview_range' ||
    request.transferGrant.ticket.length < 32 ||
    request.transferGrant.ticket.length > 2048 ||
    !Number.isInteger(request.transferGrant.maxRangeBytes) ||
    request.transferGrant.maxRangeBytes < 1 ||
    request.transferGrant.maxRangeBytes > MAX_RANGE_BYTES ||
    !Number.isInteger(request.transferGrant.maxUses) ||
    request.transferGrant.maxUses < 1 ||
    Date.parse(request.transferGrant.expiresAt) <= Date.now()
  ) {
    throw new Error('PERMISSION_DENIED');
  }
  let url: URL;
  try {
    url = new URL(request.transferUrl);
  } catch {
    throw new Error('INVALID_INPUT');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.endsWith('/functions/v1/drive-transfer/range')
  ) {
    throw new Error('INVALID_INPUT');
  }
}

function numericHeader(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function safeErrorCode(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object' &&
    !Array.isArray(payload.error) &&
    'code' in payload.error &&
    typeof payload.error.code === 'string'
  ) {
    return payload.error.code;
  }
  return response.status === 403 ? 'PERMISSION_DENIED' : 'DRIVE_UNAVAILABLE';
}

export function classifyArchivePreviewError(error: unknown): TeamPreviewUnavailableReason {
  const value = error instanceof Error ? error.message.toLocaleUpperCase('en-US') : '';
  if (value.includes('PASSWORD') || value.includes('PROTECTED') || value.includes('ENCRYPT')) {
    return 'protected';
  }
  if (
    value.includes('TOO_LARGE') ||
    value.includes('LIMIT') ||
    value.includes('TOO MANY') ||
    value.includes('LARGER') ||
    value.includes('EXPANDS') ||
    value.includes('RATIO') ||
    value.includes('NESTING')
  ) {
    return 'too_large';
  }
  if (value.includes('AGENT_REQUIRED')) return 'agent_required';
  if (value.includes('UNSUPPORTED')) return 'unsupported';
  return 'corrupt';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PREVIEW_CANCELED');
}
