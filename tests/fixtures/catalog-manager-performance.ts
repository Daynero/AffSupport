import type { CatalogUpdateProfile } from '@video-compressor/shared';
import type { CatalogRegistryRow, CatalogUpdaterState } from '../../apps/web/src/api/team';
export const CATALOG_PERFORMANCE_SIZES = [0, 60, 500, 2000] as const;
export const CATALOG_PERFORMANCE_TEAM = 'a2600000-0000-4000-8000-000000000001';
export const CATALOG_PERFORMANCE_ACTOR = 'a2600000-0000-4000-8000-000000000002';
export const CATALOG_PERFORMANCE_SEED = 47;
const uuid = (kind: number, index: number) =>
  `a2600000-0000-4000-8${kind.toString(16).padStart(3, '0')}-${index.toString(16).padStart(12, '0')}`;
/** Synthetic content only. Exactly half of each nonempty fixture matches "льон";
 * duplicate long names and stable unique video IDs exercise real identity paths. */
export function catalogManagerPerformanceFixture(size: number, seed = CATALOG_PERFORMANCE_SEED) {
  if (
    !CATALOG_PERFORMANCE_SIZES.includes(size as 0 | 60 | 500 | 2000) ||
    !Number.isSafeInteger(seed)
  )
    throw Error('Invalid A26 fixture');
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const rows: CatalogRegistryRow[] = [],
    profiles: CatalogUpdateProfile[] = [];
  const scenarios: Array<'success' | 'running' | 'error' | 'held'> = [];
  for (let index = 0; index < size; index++) {
    const kind = index % 4,
      scenario = (['success', 'running', 'error', 'held'] as const)[kind]!;
    scenarios.push(scenario);
    const catalogId = uuid(1, index + 1),
      n = 1 + (next() % 5);
    const profile: CatalogUpdateProfile = {
      catalogId,
      refreshImages: true,
      refreshTexts: index % 3 !== 0,
      growProducts: index % 5 === 0,
      randomLinkVariation: index % 3 !== 1,
      restitch: kind !== 0,
      videoVariantCount: n,
      version: 1 + (index % 7),
      updatedAt: '2026-11-01T10:00:00.000Z',
      schedule:
        index % 2 ? { timeZone: 'Europe/Kyiv', weekday: 1 + (index % 7), time: '12:30' } : null,
      lastErrorAt: kind === 2 ? '2026-11-02T10:00:00.000Z' : null,
      lastResult:
        kind === 0 ? 'success' : kind === 1 ? 'running' : kind === 2 ? 'failed' : 'partial',
      latestAttemptAt: '2026-11-02T10:00:00.000Z',
      lastSuccessfulAt: kind === 0 ? '2026-11-02T10:00:00.000Z' : null,
      restitchStatus:
        kind === 1 ? 'preparing' : kind === 2 ? 'blocked' : kind === 3 ? 'waiting' : 'ready',
      restitchBlockedCode:
        kind === 2 ? 'RESTITCH_NO_SCREENS' : kind === 3 ? 'CATALOG_PUBLICATION_PENDING' : null,
      reconciliationRequired: false
    };
    profiles.push(profile);
    rows.push({
      catalogId,
      name: `${index % 2 === 0 ? 'Український льон' : 'Зимова вовна'} — довга дубльована назва колекції «Затишок і тепло» / група ${Math.floor(index / 2) % 5}`,
      sheetUrl: `https://docs.google.com/spreadsheets/d/a26-${index}/edit`,
      videoId: uuid(2, index + 1),
      videoName: `відео-${String(index).padStart(6, '0')}.mp4`,
      folderName: 'Синтетична колекція',
      folderDriveId: 'synthetic-a26-folder',
      productCount: 100,
      createdAt: '2026-11-01T09:00:00.000Z',
      lastUpdatedAt: kind === 0 ? '2026-11-02T10:00:00.000Z' : null,
      updateCount: kind === 0 ? 7 : 0,
      inUpdater: kind !== 3,
      lastUpdateError:
        kind === 2 ? 'RESTITCH_NO_SCREENS' : kind === 3 ? 'CATALOG_PUBLICATION_PENDING' : null,
      updateInterval: kind === 3 ? null : '1d',
      nextRunAt: kind === 3 ? null : '2030-01-01T10:00:00.000Z',
      updatePending: kind === 1,
      updateStage: kind === 1 ? 'refreshing' : null,
      runtimeObservedAt: '2026-11-02T10:00:00.000Z',
      activeRoundAt: kind === 1 ? '2026-11-02T10:00:00.000Z' : null,
      activeAttemptId: kind === 1 ? uuid(3, index + 1) : null,
      progressAttemptId: kind === 1 ? uuid(3, index + 1) : null,
      restitchOperationId: kind === 1 ? uuid(4, index + 1) : null,
      restitchProgress: kind === 1 ? 37 : null,
      restitchStage: kind === 1 ? 'processing' : null,
      videoGeneration: {
        setId: uuid(5, index + 1),
        requestedCount: n,
        registeredCount: kind === 1 ? 0 : n,
        state: kind === 1 ? 'preparing' : kind === 2 ? 'unknown' : 'ready'
      },
      profile
    });
  }
  const updater: CatalogUpdaterState = {
    state: 'stopped',
    interval: '1d',
    restitch: true,
    restitchBlockedCode: null,
    nextRunAt: null,
    startedAt: null,
    catalogCount: size,
    failingCount: scenarios.filter(s => s === 'error').length,
    spareReadyCount: null,
    serverNow: '2026-11-02T10:00:00.000Z'
  };
  return {
    seed,
    size,
    rows,
    profiles,
    scenarios,
    updater,
    halfMatchQuery: 'льон',
    halfMatchCount: size / 2,
    offscreenVideoName: size ? rows[size - 1]!.videoName : null
  };
}
