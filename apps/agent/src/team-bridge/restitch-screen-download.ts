import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CompressionErrorCode,
  StitchErrorCode,
  TeamErrorCode
} from '@video-compressor/shared';
import { parseTeamEdgeResult, SCREEN_SELECTION_BOUNDS } from '@video-compressor/shared';
import { captureProtectedScreenBinding, type ProtectedScreenCacheBinding } from './screen-cache.js';
import type { DownloadedTeamSource } from './transfer.js';

const RANGE_BYTES = SCREEN_SELECTION_BOUNDS.rangeBytes;
const MAX_ERROR_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTHORITY_FAILURES = [
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'SOURCE_CHANGED',
  'EXPIRED',
  'PROCESS_CANCELED',
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'WRONG_STATE',
  'AUTH_REQUIRED',
  'REQUEST_REUSE_CONFLICT',
  'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
  'RESTITCH_SCREEN_SELECTION_LIMIT',
  'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED',
  'RESTITCH_SCREEN_BYTE_LIMIT',
  'RESTITCH_SCREEN_IO_LIMIT'
] as const satisfies readonly TeamErrorCode[];
function authorityFailure(error: unknown): TeamErrorCode {
  return (
    (error instanceof Error
      ? AUTHORITY_FAILURES.find(code => code === error.message)
      : undefined) ?? 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  );
}

/** The original opaque request survives a lost response; tickets never enter errors. */
type ScreenDownloadCode =
  | TeamErrorCode
  | Extract<CompressionErrorCode, 'DISK_FULL'>
  | Extract<StitchErrorCode, 'RESTITCH_SCREEN_FETCH_FAILED'>;
export class RestitchScreenDownloadError extends Error {
  constructor(
    public readonly code: ScreenDownloadCode,
    public readonly requestId: string | null
  ) {
    super(code);
  }
}

export interface RestitchScreenRangeAuthority {
  /** Persist request/grant IDs BEFORE issuing. Reconcile unknown outcomes there.
   * A new call here is never permission to reset the service's durable budget. */
  reserve(
    binding: Readonly<ProtectedScreenCacheBinding>,
    offset: number,
    signal: AbortSignal
  ): Promise<unknown>;
}

interface Permit {
  requestId: string;
  ticket: string;
  bytes: number;
}
function permit(
  value: unknown,
  scope: Readonly<ProtectedScreenCacheBinding>,
  offset: number
): Permit {
  const invalid = () => new RestitchScreenDownloadError('INVALID_RESPONSE', null);
  if (!value || typeof value !== 'object') throw invalid();
  const item = value as Record<string, unknown>;
  if (
    !['purpose', 'requestId', 'grantId', 'ticket', 'expiresAt', 'binding', 'offset', 'bytes'].every(
      key => Object.hasOwn(item, key)
    ) ||
    item.purpose !== 'restitch_screen_range_v1' ||
    typeof item.requestId !== 'string' ||
    !UUID.test(item.requestId) ||
    typeof item.grantId !== 'string' ||
    !UUID.test(item.grantId) ||
    typeof item.ticket !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(item.ticket) ||
    typeof item.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    item.offset !== offset ||
    item.bytes !== Math.min(RANGE_BYTES, scope.sizeBytes - offset)
  )
    throw invalid();
  let captured: Readonly<ProtectedScreenCacheBinding>;
  try {
    captured = captureProtectedScreenBinding(item.binding as ProtectedScreenCacheBinding);
  } catch {
    throw invalid();
  }
  if (JSON.stringify(captured) !== JSON.stringify(scope)) throw invalid();
  return {
    requestId: item.requestId.toLowerCase(),
    ticket: item.ticket,
    bytes: item.bytes as number
  };
}

function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RestitchScreenDownloadError('INVALID_INPUT', null);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.pathname !== '/functions/v1/drive-transfer/restitch/screen-range'
  )
    throw new RestitchScreenDownloadError('INVALID_INPUT', null);
  return url.href;
}

/** Dedicated transport, deliberately separate from generic TeamTransferGrant.
 * Server accounting is authoritative. No native retry, refresh or budget reset.
 */
export class RestitchScreenDownloader {
  readonly #endpoint: string;
  readonly #reserve: RestitchScreenRangeAuthority['reserve'];
  readonly #fetch: typeof fetch;
  readonly #temporaryRoot: string;
  constructor(options: {
    endpoint: string;
    authority: RestitchScreenRangeAuthority;
    fetchImpl?: typeof fetch;
    temporaryRoot?: string;
  }) {
    this.#endpoint = endpoint(options.endpoint);
    this.#reserve = options.authority.reserve.bind(options.authority);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async download(
    binding: ProtectedScreenCacheBinding,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource> {
    const scope = captureProtectedScreenBinding(binding);
    let requestId: string | null = null;
    const checkAbort = () => {
      if (signal.aborted) throw new RestitchScreenDownloadError('PROCESS_CANCELED', requestId);
    };
    checkAbort();
    let workspace: string;
    try {
      await mkdir(this.#temporaryRoot, { recursive: true });
      workspace = await mkdtemp(path.join(this.#temporaryRoot, 'soty-restitch-screen-'));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      throw new RestitchScreenDownloadError(
        code === 'ENOSPC' ? 'DISK_FULL' : 'RESTITCH_SCREEN_FETCH_FAILED',
        null
      );
    }
    const file = path.join(workspace, 'screen.bin');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, 'wx', 0o600);
      const hash = createHash('md5');
      let offset = 0;
      while (offset < scope.sizeBytes) {
        checkAbort();
        let issued: unknown;
        try {
          issued = await this.#reserve(scope, offset, signal);
        } catch (error) {
          // The authority persists the original request before issuing it. Keep
          // that exact correlation when a committed reservation loses its reply,
          // including on a later range; never substitute the preceding request.
          requestId =
            error instanceof RestitchScreenDownloadError &&
            typeof error.requestId === 'string' &&
            UUID.test(error.requestId)
              ? error.requestId.toLowerCase()
              : null;
          throw new RestitchScreenDownloadError(authorityFailure(error), requestId);
        }
        const grant = permit(issued, scope, offset);
        requestId = grant.requestId;
        checkAbort();
        const response = await this.#fetch(this.#endpoint, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { 'x-restitch-screen-ticket': grant.ticket }
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let eof = false;
        let failed = false;
        let failure: unknown;
        try {
          reader = response.body?.getReader();
          if (response.status !== 206 && reader) {
            // Bound failure bodies too. Never retain/forward provider text.
            const parts: Uint8Array[] = [];
            let length = 0;
            for (;;) {
              checkAbort();
              const part = await reader.read();
              checkAbort();
              if (part.done) {
                eof = true;
                break;
              }
              if (
                !(part.value instanceof Uint8Array) ||
                part.value.byteLength > MAX_ERROR_BYTES - length
              )
                throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
              if (part.value.byteLength) parts.push(part.value);
              length += part.value.byteLength;
            }
            let code: TeamErrorCode;
            try {
              if (!response.headers.get('content-type')?.startsWith('application/json'))
                throw Error();
              const payload = parseTeamEdgeResult(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
              );
              const known = payload.ok
                ? undefined
                : AUTHORITY_FAILURES.find(reason => reason === payload.error.code);
              if (!known) throw Error();
              code = known;
            } catch {
              throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
            }
            if (
              ['NOT_FOUND', 'SOURCE_CHANGED'].includes(code) &&
              response.headers.get('x-restitch-request-id') !== requestId
            )
              throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
            throw new RestitchScreenDownloadError(code, requestId);
          }
          if (
            response.status !== 206 ||
            !reader ||
            response.headers.get('content-range') !==
              `bytes ${offset}-${offset + grant.bytes - 1}/${scope.sizeBytes}` ||
            response.headers.get('content-length') !== String(grant.bytes) ||
            response.headers.get('content-type') !== scope.mimeType ||
            response.headers.get('x-restitch-request-id') !== grant.requestId
          )
            throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
          let received = 0;
          for (;;) {
            checkAbort();
            const chunk = await reader.read();
            checkAbort();
            if (chunk.done) {
              eof = true;
              break;
            }
            if (
              !(chunk.value instanceof Uint8Array) ||
              chunk.value.byteLength > grant.bytes - received
            )
              throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
            let written = 0;
            while (written < chunk.value.byteLength) {
              checkAbort();
              const result = await handle.write(
                chunk.value,
                written,
                chunk.value.byteLength - written,
                offset + received + written
              );
              if (
                !Number.isSafeInteger(result.bytesWritten) ||
                result.bytesWritten < 1 ||
                result.bytesWritten > chunk.value.byteLength - written
              )
                throw new RestitchScreenDownloadError('RESTITCH_SCREEN_FETCH_FAILED', requestId);
              written += result.bytesWritten;
            }
            hash.update(chunk.value);
            received += chunk.value.byteLength;
          }
          if (received !== grant.bytes)
            throw new RestitchScreenDownloadError('INVALID_RESPONSE', requestId);
          offset += received;
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          // Await the original stream. Abort requested is not proof that I/O stopped.
          try {
            if (reader && !eof) await reader.cancel();
          } catch {
            failed = true;
            failure = new RestitchScreenDownloadError(
              'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
              requestId
            );
          } finally {
            try {
              reader?.releaseLock();
            } catch {
              failed = true;
              failure = new RestitchScreenDownloadError(
                'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
                requestId
              );
            }
          }
        }
        if (failed) throw failure;
      }
      checkAbort();
      if ((await handle.stat()).size !== scope.sizeBytes || hash.digest('hex') !== scope.checksum)
        throw new RestitchScreenDownloadError('SOURCE_CHANGED', requestId);
      await handle.close();
      handle = undefined;
      checkAbort();
      return {
        workspace,
        file,
        sizeBytes: scope.sizeBytes,
        sourceVersion: null,
        sourceChecksum: scope.checksum,
        cleanup: () => rm(workspace, { recursive: true, force: true })
      };
    } catch (error) {
      try {
        await handle?.close();
        await rm(workspace, { recursive: true, force: true });
      } catch {
        throw new RestitchScreenDownloadError('RESTITCH_SCREEN_FETCH_FAILED', requestId);
      }
      if (error instanceof RestitchScreenDownloadError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      throw new RestitchScreenDownloadError(
        code === 'ENOSPC'
          ? 'DISK_FULL'
          : signal.aborted
            ? 'PROCESS_CANCELED'
            : 'RESTITCH_SCREEN_FETCH_FAILED',
        requestId
      );
    }
  }
}
