import { SpaceMd5, spacePartCount, spacePartRange } from '@video-compressor/shared';

/**
 * 057 T045: the part MD5s that name a file's content (research R3). One implementation for the
 * Web Worker and for the page itself where no worker can run (tests, an old engine).
 */

/** A file, or a file the paired app reads for the browser in ranges. */
export type SpaceUploadSource =
  | Blob
  | {
      size: number;
      readChunk: (start: number, endExclusive: number, signal?: AbortSignal) => Promise<Blob>;
    };

/** How much of a part is read at a time to hash it, so a 64 MiB part is never held twice. */
export const SPACE_HASH_SLICE_BYTES = 4 * 1024 * 1024;

export function readSpaceRange(
  source: SpaceUploadSource,
  start: number,
  endExclusive: number,
  signal?: AbortSignal
): Promise<Blob> {
  return source instanceof Blob
    ? Promise.resolve(source.slice(start, endExclusive))
    : source.readChunk(start, endExclusive, signal);
}

export function spaceCanceled(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('CANCELED');
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** Every part's MD5 in order, as R2 will compute it from the same bytes. */
export async function hashSpaceParts(
  source: SpaceUploadSource,
  options: { signal?: AbortSignal; onProgress?: (hashedBytes: number) => void } = {}
): Promise<string[]> {
  const total = source.size;
  const md5s: string[] = [];
  let hashed = 0;
  for (let part = 1; part <= spacePartCount(total); part += 1) {
    const range = spacePartRange(total, part);
    const md5 = new SpaceMd5();
    for (let offset = range.start; offset <= range.end; offset += SPACE_HASH_SLICE_BYTES) {
      if (options.signal?.aborted) throw spaceCanceled(options.signal);
      const end = Math.min(offset + SPACE_HASH_SLICE_BYTES, range.end + 1);
      const slice = await readSpaceRange(source, offset, end, options.signal);
      md5.update(new Uint8Array(await slice.arrayBuffer()));
      hashed += end - offset;
      options.onProgress?.(hashed);
    }
    md5s.push(hex(md5.digest()));
  }
  return md5s;
}

export interface SpaceHashRequest {
  id: number;
  source: Blob;
}

export type SpaceHashMessage =
  | { id: number; type: 'progress'; hashed: number }
  | { id: number; type: 'done'; md5s: string[] }
  | { id: number; type: 'error' };

export type SpacePartHasher = (
  source: SpaceUploadSource,
  options: { signal?: AbortSignal; onProgress?: (hashedBytes: number) => void }
) => Promise<string[]>;

let worker: Worker | null | undefined;
let nextRequest = 0;

function hashWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker =
      typeof Worker === 'undefined'
        ? null
        : new Worker(new URL('./spaceHash.worker.ts', import.meta.url), { type: 'module' });
    worker?.addEventListener('error', () => {
      worker?.terminate();
      worker = null;
    });
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * Hashes in the Web Worker when the source is a file and a worker can run, else on the page.
 * One worker for the page; a file at a time is all the uploads ask of it (the engine hashes
 * before it uploads, and one file's parts are sent while the next is hashed).
 */
export const defaultSpacePartHasher: SpacePartHasher = (source, options) => {
  const running = source instanceof Blob ? hashWorker() : null;
  if (!running || !(source instanceof Blob)) return hashSpaceParts(source, options);
  const id = (nextRequest += 1);
  return new Promise<string[]>((resolve, reject) => {
    const done = () => {
      running.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(spaceCanceled(options.signal));
    };
    const onMessage = (event: MessageEvent<SpaceHashMessage>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      if (message.type === 'progress') {
        options.onProgress?.(message.hashed);
        return;
      }
      done();
      if (message.type === 'done') resolve(message.md5s);
      // A worker that failed is not the file's fault: hash on the page instead.
      else hashSpaceParts(source, options).then(resolve, reject);
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    running.addEventListener('message', onMessage);
    running.postMessage({ id, source } satisfies SpaceHashRequest);
  });
};
