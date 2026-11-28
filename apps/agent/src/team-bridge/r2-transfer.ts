/**
 * 057 T033: the agent's transfer for a Soty space on R2 (team workspace contract 3).
 *
 * The same two halves `TeamTransferClient` has for Drive, behind the same interface, chosen by the
 * address the web hands over (`space-storage`, never `drive-transfer`/`drive-ops`):
 *
 * - **source** — the operation ticket is traded at `/agent/source` for a files-host URL with a
 *   read grant, the size and the `content_id`. The bytes are read with Range in bounded pieces.
 *   A 401 means the read grant lapsed: the ticket is traded again and the same range repeated.
 *   Every byte feeds the part hashes, and the file is handed over only when the recomputed
 *   content id is the one the server named; otherwise it is removed and nothing is kept. A file
 *   this computer already holds by that content id is read from disk instead (F11, FR-037).
 * - **result** — the output is cut into the parts its size dictates, each part's MD5 computed,
 *   and the content id declared at `/process/output/start` (protocol 3). Parts go straight to R2
 *   on URLs signed with their `Content-MD5`, at most four at once and fewer when the power
 *   governor's thread budget is lower. Each part R2 acknowledges is written to a small journal,
 *   so a transfer that broke off resumes with the parts that were missing, on the same upload.
 *   An ETag that is not the part's MD5 stops the upload before anything is committed. The
 *   server completes the upload from R2's own part list at `/process/output/finalize`.
 *
 * Nothing here logs a URL: the files URL carries a read grant and the part URLs a signature.
 */
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BUILD_ID,
  normalizePartEtag,
  SPACE_STORAGE_CAPABILITY,
  SPACE_STORAGE_CAPABILITY_HEADER,
  SPACE_STORAGE_LIMITS,
  spaceMd5HexToBase64,
  spacePartRange,
  type TeamFileOperationResult,
  type TeamTransferGrant
} from '@video-compressor/shared';
import { activeGovernorOrNull } from '../power/spawn.js';
import type { TeamSourceCache } from './source-cache.js';
import { SpacePartHasher, spaceContentOfFile } from './space-content.js';
import { TeamSourceIntegrityError } from './source-integrity.js';
import type {
  DownloadedTeamSource,
  TeamResultUploadRequest,
  TeamSourceDownloadRequest
} from './transfer.js';

const FUNCTION_PATH = '/functions/v1/space-storage';
const MAX_TRANSFER_BYTES = SPACE_STORAGE_LIMITS.maxObjectBytes;
/** Fresh read grants one source may need: the first and one per lapse (each ≤10 minutes). */
const MAX_SOURCE_REFRESHES = 48;
const MAX_PART_ATTEMPTS = 4;
const OUTPUT_UPLOAD_PROTOCOL = 3;

/** True for the address of `space-storage/agent/source`, which only an R2 space hands out. */
export function isSpaceAgentSourceUrl(value: string): boolean {
  const url = safeUrl(value, false);
  return url !== null && url.pathname.endsWith(`${FUNCTION_PATH}/agent/source`);
}

/** True for the `space-storage` function itself, the base of an R2 run's output routes. */
export function isSpaceStorageBase(value: string): boolean {
  const url = safeUrl(value, false);
  return url !== null && url.pathname.replace(/\/$/u, '').endsWith(FUNCTION_PATH);
}

export interface SpaceTransferOptions {
  fetchImpl?: typeof fetch;
  temporaryRoot?: string;
  /** Where part journals live; a resumed upload finds them here. Defaults under temporaryRoot. */
  journalRoot?: string;
  sourceCache?: Pick<TeamSourceCache, 'placeContent' | 'keepContent'> | null;
  /** How many threads the power governor allows; null when it sets no limit. */
  threadBudget?: () => number | null;
  retryDelayMs?: number;
}

interface SpaceSource {
  url: string;
  bytes: number;
  contentId: string;
}

interface UploadJournal {
  operationId: string;
  contentId: string;
  bytes: number;
  uploadId: string;
  etags: Record<string, string>;
}

export class SpaceR2Transfer {
  readonly #fetch: typeof fetch;
  readonly #temporaryRoot: string;
  readonly #journalRoot: string;
  readonly #sourceCache: Pick<TeamSourceCache, 'placeContent' | 'keepContent'> | null;
  readonly #threadBudget: () => number | null;
  readonly #retryDelayMs: number;

  constructor(options: SpaceTransferOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    this.#journalRoot = options.journalRoot ?? path.join(this.#temporaryRoot, 'soty-space-uploads');
    this.#sourceCache = options.sourceCache ?? null;
    this.#threadBudget =
      options.threadBudget ?? (() => activeGovernorOrNull()?.budget().threadBudget ?? null);
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
  }

  // Source ----------------------------------------------------------------------------------

  async downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource> {
    const endpoint = requireUrl(request.transferUrl);
    if (!endpoint.pathname.endsWith(`${FUNCTION_PATH}/agent/source`))
      throw new Error('INVALID_INPUT');
    const maximumBytes = request.maxTotalBytes ?? MAX_TRANSFER_BYTES;
    const maximumRetries = request.maxRetries ?? 4;
    const trade = () =>
      this.#source(endpoint.toString(), request.operationId, request.grant, signal);
    let source = await trade();
    if (source.bytes > maximumBytes) throw new Error('TOO_LARGE');

    await mkdir(this.#temporaryRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(this.#temporaryRoot, 'soty-team-process-'));
    const cleanup = (() => {
      let cleaned = false;
      return async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(workspace, { recursive: true, force: true });
      };
    })();
    try {
      if (this.#sourceCache) {
        const held = path.join(workspace, 'source-held.bin');
        if (await this.#sourceCache.placeContent(source.contentId, source.bytes, held, signal)) {
          request.onProgress?.(source.bytes, source.bytes);
          // The held copy's MD5 for delegates that key on it; read once from disk.
          const facts = await spaceContentOfFile(held, source.bytes, signal);
          return {
            workspace,
            file: held,
            sizeBytes: source.bytes,
            sourceVersion: source.contentId,
            sourceChecksum: facts.md5,
            cleanup
          };
        }
      }

      const file = path.join(workspace, 'source.bin');
      const handle = await open(file, 'wx', 0o600);
      const hasher = new SpacePartHasher(source.bytes);
      let offset = 0;
      let refreshes = 0;
      let retries = 0;
      try {
        while (offset < source.bytes) {
          throwIfAborted(signal);
          const end = Math.min(offset + request.grant.maxRangeBytes, source.bytes) - 1;
          const checkpoint = hasher.checkpoint();
          let response: Response | null = null;
          try {
            response = await this.#fetch(source.url, {
              method: 'GET',
              headers: { range: `bytes=${offset}-${end}` },
              cache: 'no-store',
              redirect: 'error',
              signal
            });
            if (response.status === 401) {
              // The read grant lapsed (≤10 minutes) or its key rotated: trade the ticket again.
              await response.body?.cancel().catch(() => undefined);
              refreshes += 1;
              if (refreshes > MAX_SOURCE_REFRESHES) throw new Error('PERMISSION_DENIED');
              const next = await trade();
              if (next.contentId !== source.contentId || next.bytes !== source.bytes)
                throw new Error('SOURCE_CHANGED');
              source = next;
              continue;
            }
            if (response.status === 403) throw fixed('PERMISSION_DENIED');
            if (response.status === 404) throw fixed('SOURCE_CHANGED');
            if (response.status !== 206 && !(response.status === 200 && offset === 0))
              throw transient(response.status);
            const written = await writeRange(
              response,
              handle,
              offset,
              end,
              source.bytes,
              hasher,
              signal
            );
            offset += written;
            retries = 0;
            request.onProgress?.(offset, source.bytes);
          } catch (error) {
            throwIfAborted(signal);
            hasher.restore(checkpoint);
            await handle.truncate(offset);
            await response?.body?.cancel().catch(() => undefined);
            if (!retryable(error) || retries >= maximumRetries) throw mapped(error);
            retries += 1;
            await pause(this.#retryDelayMs * Math.min(retries, 2), signal);
          }
        }
        throwIfAborted(signal);
        const facts = await hasher.finish();
        if (facts.contentId !== source.contentId)
          throw new TeamSourceIntegrityError('checksum_mismatch');
        if ((await handle.stat()).size !== source.bytes)
          throw new TeamSourceIntegrityError('size_mismatch');
        // Closed first: Windows will not link or copy a file another handle still writes.
        await handle.close();
        await this.#sourceCache?.keepContent(source.contentId, source.bytes, file);
        return {
          workspace,
          file,
          sizeBytes: source.bytes,
          sourceVersion: source.contentId,
          sourceChecksum: facts.md5,
          cleanup
        };
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  }

  async #source(
    endpoint: string,
    operationId: string,
    grant: TeamTransferGrant,
    signal: AbortSignal
  ): Promise<SpaceSource> {
    const value = await this.#edge(
      endpoint,
      {
        ...(grant.purpose === 'process_input' ? { operationId } : {}),
        ticket: grant.ticket,
        purpose: grant.purpose
      },
      signal
    );
    const url = isRecord(value) && typeof value.url === 'string' ? safeUrl(value.url, true) : null;
    if (
      !isRecord(value) ||
      !url ||
      !Number.isSafeInteger(value.bytes) ||
      (value.bytes as number) < 1 ||
      (value.bytes as number) > MAX_TRANSFER_BYTES ||
      typeof value.contentId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.contentId)
    )
      throw new Error('INVALID_RESPONSE');
    return { url: url.toString(), bytes: value.bytes as number, contentId: value.contentId };
  }

  // Result ----------------------------------------------------------------------------------

  async uploadResult(
    request: TeamResultUploadRequest,
    signal: AbortSignal
  ): Promise<TeamFileOperationResult> {
    const base = requireUrl(request.cloudBaseUrl).toString().replace(/\/$/u, '');
    if (!base.endsWith(FUNCTION_PATH)) throw new Error('INVALID_INPUT');
    throwIfAborted(signal);
    const facts = await spaceContentOfFile(request.file, request.sizeBytes, signal);
    const ticket = request.finalizeGrant.ticket;
    const started = await this.#edge(
      `${base}/process/output/start`,
      {
        operationId: request.operationId,
        ticket,
        bytes: request.sizeBytes,
        contentId: facts.contentId,
        contentType: request.mimeType,
        derivatives: [],
        outputUploadProtocolVersion: OUTPUT_UPLOAD_PROTOCOL
      },
      signal
    );
    if (!isRecord(started) || typeof started.uploadId !== 'string')
      throw new Error('INVALID_RESPONSE');
    const uploadId = started.uploadId;
    if (started.kind === 'session') {
      if (started.partCount !== facts.partMd5s.length) throw new Error('INVALID_RESPONSE');
      await this.#uploadParts(request, base, uploadId, facts, signal);
    } else if (started.kind !== 'exists') {
      throw new Error('INVALID_RESPONSE');
    }
    const finalized = await this.#finalize(
      `${base}/process/output/finalize`,
      {
        operationId: request.operationId,
        ticket,
        uploadId,
        ...(request.audioFingerprint && /^[a-f0-9]{64}$/u.test(request.audioFingerprint)
          ? { audioFingerprint: request.audioFingerprint }
          : {})
      },
      signal
    );
    if (
      !isRecord(finalized) ||
      finalized.operationId !== request.operationId ||
      !['succeeded', 'failed', 'canceled'].includes(String(finalized.state)) ||
      (finalized.materialId !== null && typeof finalized.materialId !== 'string') ||
      typeof finalized.reused !== 'boolean'
    )
      throw new Error('INVALID_RESPONSE');
    await rm(this.#journalPath(request.operationId), { force: true }).catch(() => undefined);
    return finalized as unknown as TeamFileOperationResult;
  }

  async #uploadParts(
    request: TeamResultUploadRequest,
    base: string,
    uploadId: string,
    facts: { partMd5s: string[]; contentId: string },
    signal: AbortSignal
  ): Promise<void> {
    const journal = await this.#readJournal(request.operationId, {
      contentId: facts.contentId,
      bytes: request.sizeBytes,
      uploadId
    });
    const missing = facts.partMd5s
      .map((md5, index) => ({ partNumber: index + 1, md5 }))
      .filter(part => journal.etags[String(part.partNumber)] !== part.md5);
    const total = facts.partMd5s.length;
    let completed = total - missing.length;
    request.onProgress?.(completed, total);
    const handle = await open(request.file, 'r');
    try {
      for (let index = 0; index < missing.length; index += SPACE_STORAGE_LIMITS.partUrlBatch) {
        const batch = missing.slice(index, index + SPACE_STORAGE_LIMITS.partUrlBatch);
        let urls = await this.#signParts(base, request, uploadId, batch, signal);
        const queue = [...batch];
        const width = this.#concurrency();
        let resigned = false;
        const worker = async () => {
          while (queue.length > 0) {
            throwIfAborted(signal);
            const part = queue.shift()!;
            let attempts = 0;
            for (;;) {
              attempts += 1;
              const outcome = await this.#putPart(
                handle,
                request.sizeBytes,
                part,
                urls.get(part.partNumber)!,
                signal
              );
              if (outcome === 'ok') break;
              if (outcome === 'expired' && !resigned) {
                // The signed URLs lapsed (10 minutes) under a slow link: sign what is left once.
                resigned = true;
                urls = await this.#signParts(base, request, uploadId, [part, ...queue], signal);
                continue;
              }
              if (outcome === 'mismatch') throw fixed('CHECKSUM_MISMATCH');
              if (attempts >= MAX_PART_ATTEMPTS || outcome === 'expired')
                throw new Error('STORAGE_UNAVAILABLE');
              await pause(this.#retryDelayMs * Math.min(attempts, 2), signal);
            }
            journal.etags[String(part.partNumber)] = part.md5;
            await this.#writeJournal(journal);
            completed += 1;
            request.onProgress?.(completed, total);
          }
        };
        await Promise.all(Array.from({ length: Math.min(width, batch.length) }, worker));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** ≤4 parts at once (FR-017), fewer while the power governor holds the threads down. */
  #concurrency(): number {
    const budget = this.#threadBudget();
    const cap = SPACE_STORAGE_LIMITS.agentParallelParts;
    if (budget === null || !Number.isFinite(budget)) return cap;
    return Math.max(1, Math.min(cap, Math.floor(budget)));
  }

  async #signParts(
    base: string,
    request: TeamResultUploadRequest,
    uploadId: string,
    parts: readonly { partNumber: number; md5: string }[],
    signal: AbortSignal
  ): Promise<Map<number, string>> {
    const value = await this.#edge(
      `${base}/process/output/parts`,
      {
        operationId: request.operationId,
        ticket: request.finalizeGrant.ticket,
        uploadId,
        parts: parts.map(part => ({ partNumber: part.partNumber, md5: part.md5 }))
      },
      signal
    );
    const urls = new Map<number, string>();
    if (isRecord(value) && Array.isArray(value.parts))
      for (const part of value.parts) {
        const url = isRecord(part) && typeof part.url === 'string' ? safeUrl(part.url, true) : null;
        if (isRecord(part) && Number.isSafeInteger(part.partNumber) && url)
          urls.set(part.partNumber as number, url.toString());
      }
    if (parts.some(part => !urls.has(part.partNumber))) throw new Error('INVALID_RESPONSE');
    return urls;
  }

  async #putPart(
    handle: Awaited<ReturnType<typeof open>>,
    totalBytes: number,
    part: { partNumber: number; md5: string },
    url: string,
    signal: AbortSignal
  ): Promise<'ok' | 'retry' | 'expired' | 'mismatch'> {
    const range = spacePartRange(totalBytes, part.partNumber);
    const contentMd5 = spaceMd5HexToBase64(part.md5);
    if (!contentMd5) throw new Error('INVALID_RESPONSE');
    const bytes = Buffer.allocUnsafe(range.bytes);
    const { bytesRead } = await handle.read(bytes, 0, range.bytes, range.start);
    if (bytesRead !== range.bytes) throw new Error('SOURCE_CHANGED');
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'PUT',
        headers: {
          'content-length': String(range.bytes),
          'content-md5': contentMd5
        },
        body: bytes,
        cache: 'no-store',
        redirect: 'error',
        signal
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof TypeError) return 'retry';
      throw error;
    }
    await response.body?.cancel().catch(() => undefined);
    // R2 refuses bytes that are not the signed MD5 (400 BadDigest): the file changed under us
    // or the link damaged it. Never retried into a commit.
    if (response.status === 400) return 'mismatch';
    if (response.status === 403) return 'expired';
    if (response.status === 429 || response.status >= 500) return 'retry';
    if (response.status !== 200) return 'retry';
    const etag = normalizePartEtag(response.headers.get('etag'));
    if (etag !== part.md5) return 'mismatch';
    return 'ok';
  }

  async ackUploadQuiescence(request: {
    operationId: string;
    cloudBaseUrl: string;
    finalizeGrant: TeamTransferGrant;
  }): Promise<void> {
    const base = requireUrl(request.cloudBaseUrl).toString().replace(/\/$/u, '');
    if (!base.endsWith(FUNCTION_PATH)) throw new Error('INVALID_INPUT');
    await this.#edge(
      `${base}/process/output/quiesced`,
      { operationId: request.operationId, ticket: request.finalizeGrant.ticket },
      AbortSignal.timeout(10_000)
    );
  }

  // Journal ---------------------------------------------------------------------------------

  #journalPath(operationId: string): string {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) throw new Error('INVALID_INPUT');
    return path.join(this.#journalRoot, `${operationId.replaceAll(':', '_')}.json`);
  }

  /** The parts R2 already holds for this output, if the journal is for these very bytes. */
  async #readJournal(
    operationId: string,
    expected: { contentId: string; bytes: number; uploadId: string }
  ): Promise<UploadJournal> {
    const fresh: UploadJournal = { operationId, ...expected, etags: {} };
    try {
      const value: unknown = JSON.parse(await readFile(this.#journalPath(operationId), 'utf8'));
      if (
        isRecord(value) &&
        value.operationId === operationId &&
        value.contentId === expected.contentId &&
        value.bytes === expected.bytes &&
        value.uploadId === expected.uploadId &&
        isRecord(value.etags)
      ) {
        const etags: Record<string, string> = {};
        for (const [part, etag] of Object.entries(value.etags))
          if (
            /^[1-9][0-9]{0,4}$/u.test(part) &&
            typeof etag === 'string' &&
            /^[0-9a-f]{32}$/u.test(etag)
          )
            etags[part] = etag;
        return { ...fresh, etags };
      }
    } catch {
      // No journal, or one that cannot be read: every part is sent.
    }
    return fresh;
  }

  async #writeJournal(journal: UploadJournal): Promise<void> {
    const target = this.#journalPath(journal.operationId);
    const staging = `${target}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await mkdir(this.#journalRoot, { recursive: true });
      await writeFile(staging, JSON.stringify(journal), { mode: 0o600 });
      await rename(staging, target);
    } catch {
      // A journal that could not be written only costs re-sending parts after a break.
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }

  // Edge ------------------------------------------------------------------------------------

  /** Finalization is idempotent for this upload; a lost reply is asked again, never re-sent. */
  async #finalize(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#edge(url, body, signal);
      } catch (error) {
        throwIfAborted(signal);
        if (attempt >= 2 || !retryable(error)) throw mapped(error);
        await pause(this.#retryDelayMs * (attempt + 1), signal);
      }
    }
  }

  async #edge(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SPACE_STORAGE_CAPABILITY_HEADER]: SPACE_STORAGE_CAPABILITY,
        'x-soty-client': `agent/${BUILD_ID}`
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
          ? payload.error.code
          : response.status === 403
            ? 'PERMISSION_DENIED'
            : 'STORAGE_UNAVAILABLE';
      const flag =
        isRecord(payload) && isRecord(payload.error) && typeof payload.error.retryable === 'boolean'
          ? payload.error.retryable
          : undefined;
      throw Object.assign(new Error(code), { retryable: flag });
    }
    if (!isRecord(payload) || payload.ok !== true || !('value' in payload))
      throw new Error('INVALID_RESPONSE');
    return payload.value;
  }
}

async function writeRange(
  response: Response,
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  end: number,
  total: number,
  hasher: SpacePartHasher,
  signal: AbortSignal
): Promise<number> {
  const expected = end - offset + 1;
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
    if (
      !match ||
      Number(match[1]) !== offset ||
      Number(match[2]) !== end ||
      Number(match[3]) !== total
    )
      throw new Error('INVALID_RESPONSE');
  } else if (end + 1 !== total) {
    // A whole-file 200 is only acceptable when the first range was the whole file.
    throw new Error('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_RESPONSE');
  let received = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expected) throw new Error('INVALID_RESPONSE');
      let written = 0;
      while (written < value.byteLength) {
        const result = await handle.write(
          value,
          written,
          value.byteLength - written,
          offset + received + written
        );
        if (result.bytesWritten < 1) throw new Error('INVALID_RESPONSE');
        written += result.bytesWritten;
      }
      hasher.update(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (received !== expected) throw transient(0);
  return received;
}

function safeUrl(value: string, allowAnyPath: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash
  )
    return null;
  if (!allowAnyPath) url.search = '';
  return url;
}

function requireUrl(value: string): URL {
  const url = safeUrl(value, false);
  if (!url) throw new Error('INVALID_INPUT');
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixed(code: string): Error {
  return Object.assign(new Error(code), { retryable: false });
}

function transient(status: number): Error {
  return Object.assign(new Error(status === 429 ? 'RATE_LIMITED' : 'STORAGE_UNAVAILABLE'), {
    retryable: true
  });
}

function retryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error && error.retryable === false)
    return false;
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.message === 'STORAGE_UNAVAILABLE' || error.message === 'RATE_LIMITED'))
  );
}

function mapped(error: unknown): unknown {
  return error instanceof TypeError ? new Error('STORAGE_UNAVAILABLE') : error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}
