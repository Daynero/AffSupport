import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TeamFileOperationResult, TeamTransferGrant } from '@video-compressor/shared';

const MAX_RANGE_BYTES = 32 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024 * 1024;
const UPLOAD_CHUNK_MULTIPLE = 256 * 1024;

export interface TeamSourceDownloadRequest {
  operationId: string;
  transferUrl: string;
  grant: TeamTransferGrant;
}

export interface DownloadedTeamSource {
  workspace: string;
  file: string;
  sizeBytes: number;
  sourceVersion: string | null;
  sourceChecksum: string | null;
  cleanup: () => Promise<void>;
}

export interface TeamResultUploadRequest {
  operationId: string;
  cloudBaseUrl: string;
  finalizeGrant: TeamTransferGrant;
  file: string;
  mimeType: string;
  sizeBytes: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface TeamTransferClientOptions {
  fetchImpl?: typeof fetch;
  temporaryRoot?: string;
}

export class TeamTransferClient {
  readonly #fetch: typeof fetch;
  readonly #temporaryRoot: string;

  constructor(options: TeamTransferClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource> {
    validateOperationId(request.operationId);
    validateTransferGrant(request.grant, ['process_input', 'download_range']);
    const endpoint = transferUrl(request.transferUrl);
    await mkdir(this.#temporaryRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(this.#temporaryRoot, 'wishly-team-process-'));
    const file = path.join(workspace, 'source.bin');
    const handle = await open(file, 'wx', 0o600);
    let offset = 0;
    let totalBytes: number | null = null;
    let sourceVersion: string | null = null;
    let sourceChecksum: string | null = null;
    let uses = 0;
    try {
      while (totalBytes === null || offset < totalBytes) {
        throwIfAborted(signal);
        uses += 1;
        if (uses > request.grant.maxUses) throw new Error('PERMISSION_DENIED');
        const end = Math.min(offset + request.grant.maxRangeBytes - 1, MAX_TRANSFER_BYTES - 1);
        if (end < offset) throw new Error('TOO_LARGE');
        const response = await this.#fetch(endpoint, {
          method: 'GET',
          headers: {
            range: `bytes=${offset}-${end}`,
            'x-wishly-transfer-grant': request.grant.ticket
          },
          cache: 'no-store',
          redirect: 'error',
          signal
        });
        if (response.status !== 200 && response.status !== 206) {
          throw new Error(await edgeError(response));
        }
        const responseVersion = response.headers.get('x-wishly-source-version');
        const responseChecksum = response.headers.get('x-wishly-source-checksum');
        if (offset === 0) {
          sourceVersion = responseVersion;
          sourceChecksum = responseChecksum;
        } else if (sourceVersion !== responseVersion || sourceChecksum !== responseChecksum) {
          throw new Error('SOURCE_CHANGED');
        }
        const length = numericHeader(response.headers.get('content-length'));
        const range = response.headers.get('content-range');
        const rangeMatch = range ? /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range) : null;
        if (response.status === 206) {
          if (!rangeMatch || Number(rangeMatch[1]) !== offset) throw new Error('INVALID_RESPONSE');
          const responseEnd = Number(rangeMatch[2]);
          const declaredTotal = Number(rangeMatch[3]);
          if (
            !Number.isSafeInteger(responseEnd) ||
            !Number.isSafeInteger(declaredTotal) ||
            responseEnd < offset ||
            responseEnd > end ||
            declaredTotal <= responseEnd ||
            declaredTotal > MAX_TRANSFER_BYTES ||
            length !== responseEnd - offset + 1
          ) {
            throw new Error(declaredTotal > MAX_TRANSFER_BYTES ? 'TOO_LARGE' : 'INVALID_RESPONSE');
          }
          totalBytes = declaredTotal;
          const requiredUses = Math.ceil(totalBytes / request.grant.maxRangeBytes);
          if (requiredUses > request.grant.maxUses) throw new Error('PERMISSION_DENIED');
        } else {
          if (offset !== 0 || length === null || length > request.grant.maxRangeBytes) {
            throw new Error('INVALID_RESPONSE');
          }
          totalBytes = length;
        }
        const reader = response.body?.getReader();
        if (!reader || length === null || length < 1) throw new Error('INVALID_RESPONSE');
        let responseBytes = 0;
        while (true) {
          throwIfAborted(signal);
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.byteLength;
          if (
            responseBytes > request.grant.maxRangeBytes ||
            responseBytes > length ||
            offset + responseBytes > MAX_TRANSFER_BYTES
          ) {
            await reader.cancel();
            throw new Error('TOO_LARGE');
          }
          await handle.write(value, 0, value.byteLength, offset + responseBytes - value.byteLength);
        }
        if (responseBytes !== length) throw new Error('INVALID_RESPONSE');
        offset += responseBytes;
      }
      if (totalBytes === null || totalBytes < 1 || offset !== totalBytes) {
        throw new Error('INVALID_RESPONSE');
      }
      let cleaned = false;
      return {
        workspace,
        file,
        sizeBytes: totalBytes,
        sourceVersion,
        sourceChecksum,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await rm(workspace, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async uploadResult(
    request: TeamResultUploadRequest,
    signal: AbortSignal
  ): Promise<TeamFileOperationResult> {
    validateOperationId(request.operationId);
    validateTransferGrant(request.finalizeGrant, ['finalize']);
    const baseUrl = cloudBaseUrl(request.cloudBaseUrl);
    const source = await stat(request.file);
    if (
      !source.isFile() ||
      source.size !== request.sizeBytes ||
      source.size < 1 ||
      source.size > MAX_TRANSFER_BYTES
    ) {
      throw new Error(source.size > MAX_TRANSFER_BYTES ? 'TOO_LARGE' : 'SOURCE_CHANGED');
    }
    const start = await this.#edgeJson(
      `${baseUrl}/process/output/start`,
      {
        operationId: request.operationId,
        ticket: request.finalizeGrant.ticket,
        sizeBytes: request.sizeBytes,
        mimeType: request.mimeType
      },
      signal
    );
    const sessionUri = recordString(start, 'sessionUri');
    const chunkMultiple = recordInteger(start, 'chunkMultiple');
    if (!sessionUri || chunkMultiple !== UPLOAD_CHUNK_MULTIPLE) throw new Error('INVALID_RESPONSE');
    validateGoogleSession(sessionUri);

    const handle = await open(request.file, 'r');
    let offset = 0;
    let driveFileId: string | null = null;
    try {
      while (offset < request.sizeBytes && !driveFileId) {
        throwIfAborted(signal);
        const length = Math.min(UPLOAD_CHUNK_MULTIPLE, request.sizeBytes - offset);
        const bytes = Buffer.allocUnsafe(length);
        const read = await handle.read(bytes, 0, length, offset);
        if (read.bytesRead !== length) throw new Error('SOURCE_CHANGED');
        const end = offset + length - 1;
        const response = await this.#fetch(sessionUri, {
          method: 'PUT',
          headers: {
            'content-length': String(length),
            'content-range': `bytes ${offset}-${end}/${request.sizeBytes}`
          },
          body: bytes,
          cache: 'no-store',
          redirect: 'error',
          signal
        });
        if (response.status === 308) {
          const next = resumableOffset(response.headers, request.sizeBytes);
          if (next <= offset || next > end + 1) throw new Error('INVALID_RESPONSE');
          offset = next;
          request.onProgress?.(offset, request.sizeBytes);
          continue;
        }
        if (response.status !== 200 && response.status !== 201) {
          throw new Error(await edgeError(response));
        }
        const payload: unknown = await response.json().catch(() => null);
        driveFileId = isRecord(payload) && typeof payload.id === 'string' ? payload.id : null;
        if (!driveFileId) throw new Error('INVALID_RESPONSE');
        offset = request.sizeBytes;
        request.onProgress?.(offset, request.sizeBytes);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!driveFileId) throw new Error('INVALID_RESPONSE');
    const finalized = await this.#edgeJson(
      `${baseUrl}/process/output/finalize`,
      {
        operationId: request.operationId,
        ticket: request.finalizeGrant.ticket,
        driveFileId
      },
      signal
    );
    if (
      !isRecord(finalized) ||
      finalized.operationId !== request.operationId ||
      !['succeeded', 'failed', 'canceled'].includes(String(finalized.state)) ||
      (finalized.materialId !== null && typeof finalized.materialId !== 'string') ||
      typeof finalized.reused !== 'boolean'
    ) {
      throw new Error('INVALID_RESPONSE');
    }
    return finalized as unknown as TeamFileOperationResult;
  }

  async #edgeJson(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(edgePayloadError(payload, response.status));
    if (!isRecord(payload) || payload.ok !== true || !('value' in payload)) {
      throw new Error('INVALID_RESPONSE');
    }
    return payload.value;
  }
}

function validateOperationId(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new Error('INVALID_INPUT');
}

function validateTransferGrant(
  grant: TeamTransferGrant,
  purposes: ReadonlyArray<TeamTransferGrant['purpose']>
) {
  if (
    !purposes.includes(grant.purpose) ||
    grant.ticket.length < 32 ||
    grant.ticket.length > 2048 ||
    Date.parse(grant.expiresAt) <= Date.now() ||
    !Number.isInteger(grant.maxRangeBytes) ||
    grant.maxRangeBytes < 1 ||
    grant.maxRangeBytes > MAX_RANGE_BYTES ||
    !Number.isInteger(grant.maxUses) ||
    grant.maxUses < 1 ||
    grant.maxUses > 10_000
  ) {
    throw new Error('PERMISSION_DENIED');
  }
}

function safeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_INPUT');
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('INVALID_INPUT');
  }
  return url;
}

function transferUrl(value: string): string {
  const url = safeUrl(value);
  if (!url.pathname.endsWith('/functions/v1/drive-transfer/range')) {
    throw new Error('INVALID_INPUT');
  }
  url.search = '';
  return url.toString();
}

function cloudBaseUrl(value: string): string {
  const url = safeUrl(value);
  if (!url.pathname.endsWith('/functions/v1/drive-ops')) throw new Error('INVALID_INPUT');
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function validateGoogleSession(value: string) {
  const url = safeUrl(value);
  if (!['www.googleapis.com', 'content.googleapis.com'].includes(url.hostname)) {
    throw new Error('INVALID_RESPONSE');
  }
}

function numericHeader(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function resumableOffset(headers: Headers, totalBytes: number) {
  const match = /^bytes=0-(\d+)$/u.exec(headers.get('range') ?? '');
  if (!match) throw new Error('INVALID_RESPONSE');
  const offset = Number(match[1]) + 1;
  if (
    !Number.isSafeInteger(offset) ||
    offset <= 0 ||
    offset > totalBytes ||
    (offset < totalBytes && offset % UPLOAD_CHUNK_MULTIPLE !== 0)
  ) {
    throw new Error('INVALID_RESPONSE');
  }
  return offset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function recordInteger(value: unknown, key: string): number | null {
  const entry = isRecord(value) ? value[key] : null;
  return typeof entry === 'number' && Number.isInteger(entry) ? entry : null;
}

function edgePayloadError(payload: unknown, status: number) {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string') {
    return payload.error.code;
  }
  return status === 403 ? 'PERMISSION_DENIED' : 'DRIVE_UNAVAILABLE';
}

async function edgeError(response: Response) {
  return edgePayloadError(await response.json().catch(() => null), response.status);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
}
