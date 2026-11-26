import type { RestitchPoolSummary, RestitchSourcesListing } from '@video-compressor/shared';

/**
 * The files a pool would have held and cannot use (2026-11-26).
 *
 * The server keeps them out of the pool — an operating system's own file («._photo.png»), bytes
 * an agent could not decode, a file too small to hold a picture that Drive read none in — and
 * says which they are, so their owner can find them in Drive. The field rides beside the pool
 * the shared parser reads: it is the browser's own part of the listing, read here and nowhere
 * else, and a server from before it simply sends none.
 */

export const UNUSABLE_SCREEN_REASONS = ['service_file', 'undecodable', 'not_an_image'] as const;
export type UnusableScreenReason = (typeof UNUSABLE_SCREEN_REASONS)[number] | 'unknown';

export interface UnusableScreen {
  materialId: string;
  name: string;
  /** The folder the file lies in; empty when the catalog does not know it. */
  folderName: string;
  sizeBytes: number | null;
  reason: UnusableScreenReason;
}

export interface UnusableScreens {
  /** Every unusable file of the pool, listed or not. */
  count: number;
  /** The first of them; the server lists at most two hundred. */
  items: UnusableScreen[];
}

/** A pool as this build reads it: the shared shape, plus the files it could not take. */
export type RestitchPoolWithUnusable = RestitchPoolSummary & { unusable?: UnusableScreens };

const NONE: UnusableScreens = Object.freeze({ count: 0, items: [] }) as UnusableScreens;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Lenient on purpose: a malformed entry is dropped, never a reason to lose the listing. */
export function parseUnusableScreens(value: unknown): UnusableScreens {
  if (!isRecord(value)) return NONE;
  const items: UnusableScreen[] = [];
  for (const entry of Array.isArray(value.items) ? value.items : []) {
    if (!isRecord(entry) || typeof entry.materialId !== 'string' || !entry.materialId) continue;
    if (typeof entry.name !== 'string' || !entry.name) continue;
    items.push({
      materialId: entry.materialId,
      name: entry.name,
      folderName: typeof entry.folderName === 'string' ? entry.folderName : '',
      sizeBytes: wholeNumber(entry.sizeBytes),
      // A reason this build has no words for is still a file the pool cannot use.
      reason: (UNUSABLE_SCREEN_REASONS as readonly string[]).includes(entry.reason as string)
        ? (entry.reason as UnusableScreenReason)
        : 'unknown'
    });
  }
  const count = Math.max(wholeNumber(value.count) ?? 0, items.length);
  return count === 0 ? NONE : { count, items };
}

/**
 * The listing the shared parser returned, with each pool's unusable files beside it. A pool
 * that has none keeps exactly the shape it always had.
 */
export function withUnusableScreens(
  listing: RestitchSourcesListing,
  raw: unknown
): RestitchSourcesListing {
  const pools = isRecord(raw) && isRecord(raw.pools) ? raw.pools : {};
  const read = (slot: 'start' | 'end'): RestitchPoolWithUnusable => {
    const pool = pools[slot];
    const unusable = parseUnusableScreens(isRecord(pool) ? pool.unusable : null);
    return unusable.count > 0 ? { ...listing.pools[slot], unusable } : listing.pools[slot];
  };
  return { ...listing, pools: { start: read('start'), end: read('end') } };
}

export function unusableScreensOf(pool: RestitchPoolSummary | null | undefined): UnusableScreens {
  return (pool as RestitchPoolWithUnusable | null | undefined)?.unusable ?? NONE;
}
