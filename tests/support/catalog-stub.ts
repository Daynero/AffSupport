import type { CatalogSearchResponse } from '@video-compressor/shared';

type Freshness = CatalogSearchResponse['catalogFreshness'];

/**
 * A catalog that has finished syncing.
 *
 * `catalogFreshness` grew three fields when the scan learned to report progress
 * — a discovered count, a remaining-folder count and a last-activity stamp —
 * and the fixtures that predate them are spread across several suites. They
 * were all excluded from the typecheck, so all of them kept describing a
 * response shape the API had stopped returning.
 */
export function freshnessStub(overrides: Partial<Freshness> = {}): Freshness {
  return {
    state: 'ready',
    lastSyncedAt: '2026-07-18T00:00:00.000Z',
    discoveredCount: 0,
    foldersRemaining: null,
    lastProgressAt: null,
    ...overrides
  };
}

/** An empty result set, with the freshness block filled in. */
export function catalogSearchStub(
  overrides: Partial<CatalogSearchResponse> = {}
): CatalogSearchResponse {
  return {
    items: [],
    total: 0,
    activeFilters: {},
    facets: { geo: [], language: [], offer: [], category: [] },
    catalogFreshness: freshnessStub(),
    ...overrides
  };
}
