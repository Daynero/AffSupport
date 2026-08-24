import type { TeamPreviewResult } from '@video-compressor/shared';

type PreviewMode = 'media' | 'transcript' | 'archive' | 'landing';

/**
 * Session-scoped cache of signed preview URLs.
 *
 * A grid of fifty cards used to ask for fifty signed URLs, and ask again every
 * time a card re-rendered — a scroll back up cost another round trip per tile
 * (finding P2, SC-009). The grants are short-lived, so an entry is dropped a
 * little before it expires rather than trusted to the last second.
 */
const cache = new Map<string, { result: TeamPreviewResult; expiresAt: number }>();

/** Re-fetch this long before the grant actually lapses. */
const SAFETY_MARGIN_MS = 30_000;

function key(teamId: string, materialId: string, mode: PreviewMode): string {
  return `${teamId}:${materialId}:${mode}`;
}

function expiryOf(result: TeamPreviewResult): number {
  const raw = 'expiresAt' in result ? result.expiresAt : null;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
  // A result with no expiry it will admit to is cached for a minute, not
  // forever: guessing long is how a stale signed URL reaches a video element.
  return Number.isNaN(parsed) ? Date.now() + 60_000 : parsed;
}

/**
 * Fetch a preview, reusing a live grant for the same material and mode.
 *
 * Concurrent callers for the same key share one request, which is what stops a
 * grid from firing fifty identical ones as it paints.
 */
const inFlight = new Map<string, Promise<TeamPreviewResult>>();

export function cachedPreview(
  fetcher: (teamId: string, materialId: string, mode: PreviewMode) => Promise<TeamPreviewResult>,
  teamId: string,
  materialId: string,
  mode: PreviewMode
): Promise<TeamPreviewResult> {
  const id = key(teamId, materialId, mode);
  const cached = cache.get(id);
  if (cached && cached.expiresAt - SAFETY_MARGIN_MS > Date.now()) {
    return Promise.resolve(cached.result);
  }
  const pending = inFlight.get(id);
  if (pending) return pending;

  const request = fetcher(teamId, materialId, mode)
    .then(result => {
      cache.set(id, { result, expiresAt: expiryOf(result) });
      return result;
    })
    .finally(() => {
      inFlight.delete(id);
    });
  inFlight.set(id, request);
  return request;
}

/** Drops everything. Used by tests, and after a material changes on the server. */
export function clearPreviewUrlCache(): void {
  cache.clear();
  inFlight.clear();
}
