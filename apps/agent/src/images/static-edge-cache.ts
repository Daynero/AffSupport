import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { StaticEdgeTrims } from './static-edges.js';

type Detector = (
  input: string,
  duration: number,
  frameRate: number,
  signal?: AbortSignal
) => Promise<StaticEdgeTrims>;

/** Completed scans only: cancellation belongs to each caller, never to a shared promise. */
export class StaticEdgeTrimCache {
  private readonly entries = new Map<string, StaticEdgeTrims>();

  constructor(
    private readonly scan: Detector,
    private readonly limit = 64
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid edge cache limit');
  }

  async detect(input: string, duration: number, frameRate: number, signal?: AbortSignal) {
    checkAborted(signal);
    const before = await sourceIdentity(input);
    checkAborted(signal);
    const key = JSON.stringify([path.resolve(input), before, duration, frameRate]);
    const cached = before === null ? undefined : this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { ...cached };
    }
    const result = await this.scan(input, duration, frameRate, signal);
    checkAborted(signal);
    // A file changed during inspection must not seed a later compression's cache.
    const after = before === null ? null : await sourceIdentity(input);
    checkAborted(signal);
    if (before !== null && before === after) {
      this.entries.set(key, { ...result });
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    }
    return { ...result };
  }
}

async function sourceIdentity(input: string): Promise<string | null> {
  try {
    const file = await stat(input, { bigint: true });
    if (!file.isFile()) return null;
    // ctime catches same-size rewrites with a restored mtime; inode catches replacement.
    return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
  } catch {
    // Keep the detector's original error/unsupported-file behavior when stat is unavailable.
    return null;
  }
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Static edge detection was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
