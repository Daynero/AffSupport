import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
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

const MAX_RANGE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024;

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
  workspace: string;
  screenshotFiles: string[];
}

export interface TeamPreviewBridgeOptions {
  fetchImpl?: typeof fetch;
  temporaryRoot?: string;
  origin?: LandingPreviewOrigin;
  renderer?: Pick<LandingPageRenderer, 'init' | 'availability' | 'render' | 'shutdown'>;
}

export class TeamPreviewBridge {
  readonly #fetch: typeof fetch;
  readonly #temporaryRoot: string;
  readonly #origin: LandingPreviewOrigin;
  readonly #renderer: Pick<LandingPageRenderer, 'init' | 'availability' | 'render' | 'shutdown'>;
  readonly #controllers = new Map<string, AbortController>();
  readonly #landingSessions = new Map<string, LandingSession>();
  #initialized = false;

  constructor(options: TeamPreviewBridgeOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#temporaryRoot = options.temporaryRoot ?? os.tmpdir();
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
      downloaded = await this.#download(request, controller.signal);
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
      const origin = await this.#origin.open({
        operationId: request.operationId,
        root: landingDirectory,
        entryFile: path.posix.basename(entry.path),
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
    if (session && !originClosed) {
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
