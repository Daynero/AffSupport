import { UPLOAD_CHUNK_MULTIPLE_BYTES } from '@video-compressor/shared';

const MAX_RELAY_CHUNK_BYTES = 32 * 1024 * 1024;

export interface RelayChunkBounds {
  offset: number;
  contentLength: number;
  totalBytes: number;
}

function uploadError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateRelayChunk(input: RelayChunkBounds): { start: number; end: number } {
  if (
    !safeInteger(input.offset) ||
    !safeInteger(input.contentLength) ||
    !safeInteger(input.totalBytes) ||
    input.contentLength < 1 ||
    input.offset >= input.totalBytes ||
    input.offset % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0 ||
    input.offset + input.contentLength > input.totalBytes
  ) {
    throw uploadError('INVALID_INPUT');
  }
  if (input.contentLength > MAX_RELAY_CHUNK_BYTES) throw uploadError('TOO_LARGE');
  const end = input.offset + input.contentLength - 1;
  if (end + 1 < input.totalBytes && input.contentLength % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0) {
    throw uploadError('INVALID_INPUT');
  }
  return { start: input.offset, end };
}

/** Returns the next byte Google expects after an incomplete resumable PUT. */
export function parseResumableOffset(status: number, headers: Headers, totalBytes: number): number {
  if (status !== 308 || !safeInteger(totalBytes)) throw uploadError('INVALID_RESPONSE');
  const value = headers.get('range');
  if (!value) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(value.trim());
  if (!match) throw uploadError('INVALID_RESPONSE');
  const lastReceived = Number(match[1]);
  const offset = lastReceived + 1;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > totalBytes ||
    (offset !== totalBytes && offset % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0)
  ) {
    throw uploadError('INVALID_RESPONSE');
  }
  return offset;
}

function validateSessionUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw uploadError('INVALID_INPUT');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw uploadError('INVALID_INPUT');
  }
  return url;
}

function responseFileId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length >= 1 && id.length <= 1024 ? id : null;
}

async function completedFileId(response: Response): Promise<string> {
  if (response.status !== 200 && response.status !== 201) throw uploadError('INVALID_RESPONSE');
  const id = responseFileId(await response.json().catch(() => null));
  if (!id) throw uploadError('INVALID_RESPONSE');
  return id;
}

async function queryOffset(input: {
  fetchImpl: typeof fetch;
  sessionUri: string;
  totalBytes: number;
  signal?: AbortSignal;
}): Promise<{ offset: number; driveFileId: string | null }> {
  const response = await input.fetchImpl(input.sessionUri, {
    method: 'PUT',
    headers: new Headers({
      'content-length': '0',
      'content-range': `bytes */${input.totalBytes}`
    }),
    body: null,
    cache: 'no-store',
    redirect: 'error',
    signal: input.signal
  });
  if (response.status === 200 || response.status === 201) {
    return { offset: input.totalBytes, driveFileId: await completedFileId(response) };
  }
  return {
    offset: parseResumableOffset(response.status, response.headers, input.totalBytes),
    driveFileId: null
  };
}

/**
 * Sends one chunk and says what the provider did with it.
 *
 * A resumable session opened by the server carries no browser origin, so a
 * `PUT` straight to it is refused before it leaves the tab. Every chunk goes
 * through the relay the start call hands back, which forwards it under the
 * team's own credential; the shape below is all the upload loop needs to know
 * about either route.
 */
export type ChunkOutcome =
  { complete: true; driveFileId: string } | { complete: false; nextOffset: number };

export type SendChunk = (input: {
  chunk: Blob;
  offset: number;
  endExclusive: number;
  totalBytes: number;
  signal?: AbortSignal;
}) => Promise<ChunkOutcome>;

export interface ResumableUploadInput<TFinalize> {
  source: Blob;
  sessionUri: string;
  /** Sends the bytes. Without one the chunk goes straight to the session. */
  sendChunk?: SendChunk;
  operationId: string;
  idempotencyKey: string;
  chunkBytes?: number;
  fetchImpl?: typeof fetch;
  finalize: (input: {
    operationId: string;
    driveFileId: string;
    idempotencyKey: string;
  }) => Promise<TFinalize>;
  signal?: AbortSignal;
  maximumRecoveryQueries?: number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Uploads from memory-held session state only. The resumable URI is never
 * persisted, logged, added to errors, analytics, or returned by this helper.
 */
export async function resumableUpload<TFinalize>(
  input: ResumableUploadInput<TFinalize>
): Promise<TFinalize> {
  validateSessionUri(input.sessionUri);
  if (!(input.source instanceof Blob) || input.source.size < 1) throw uploadError('INVALID_INPUT');
  const chunkBytes = input.chunkBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < UPLOAD_CHUNK_MULTIPLE_BYTES ||
    chunkBytes > MAX_RELAY_CHUNK_BYTES ||
    chunkBytes % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0
  ) {
    throw uploadError('INVALID_INPUT');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const maximumRecoveryQueries = Math.min(
    Math.max(Math.trunc(input.maximumRecoveryQueries ?? 4), 0),
    12
  );
  let recoveries = 0;
  let offset = 0;
  let driveFileId: string | null = null;

  while (offset < input.source.size && !driveFileId) {
    if (input.signal?.aborted) throw input.signal.reason ?? uploadError('CANCELED');
    const endExclusive = Math.min(offset + chunkBytes, input.source.size);
    const chunk = input.source.slice(offset, endExclusive);
    const headers = new Headers({
      'content-length': String(chunk.size),
      'content-range': `bytes ${offset}-${endExclusive - 1}/${input.source.size}`
    });
    let response: Response | null;
    try {
      if (input.sendChunk) {
        const outcome = await input.sendChunk({
          chunk,
          offset,
          endExclusive,
          totalBytes: input.source.size,
          signal: input.signal
        });
        if (outcome.complete) {
          driveFileId = outcome.driveFileId;
          offset = input.source.size;
          input.onProgress?.(offset, input.source.size);
          continue;
        }
        if (outcome.nextOffset <= offset || outcome.nextOffset > endExclusive) {
          throw uploadError('INVALID_RESPONSE');
        }
        offset = outcome.nextOffset;
        input.onProgress?.(offset, input.source.size);
        continue;
      }
      response = await fetchImpl(input.sessionUri, {
        method: 'PUT',
        headers,
        body: chunk,
        cache: 'no-store',
        redirect: 'error',
        signal: input.signal
      });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? uploadError('CANCELED', error);
      if (error instanceof Error && error.message === 'INVALID_RESPONSE') throw error;
      if (recoveries >= maximumRecoveryQueries) throw uploadError('DRIVE_UNAVAILABLE', error);
      recoveries += 1;
      // Through the relay the provider is not reachable for an offset query, and
      // re-sending the same range is what a resumable session expects anyway.
      if (input.sendChunk) continue;
      const recovered = await queryOffset({
        fetchImpl,
        sessionUri: input.sessionUri,
        totalBytes: input.source.size,
        signal: input.signal
      }).catch(queryError => {
        throw uploadError('DRIVE_UNAVAILABLE', queryError);
      });
      offset = recovered.offset;
      driveFileId = recovered.driveFileId;
      input.onProgress?.(offset, input.source.size);
      continue;
    }

    if (!response) continue;
    if (response.status === 308) {
      const nextOffset = parseResumableOffset(response.status, response.headers, input.source.size);
      if (nextOffset <= offset || nextOffset > endExclusive) throw uploadError('INVALID_RESPONSE');
      offset = nextOffset;
      input.onProgress?.(offset, input.source.size);
      continue;
    }
    driveFileId = await completedFileId(response);
    offset = input.source.size;
    input.onProgress?.(offset, input.source.size);
  }

  if (!driveFileId) throw uploadError('INVALID_RESPONSE');
  return input.finalize({
    operationId: input.operationId,
    driveFileId,
    idempotencyKey: input.idempotencyKey
  });
}
