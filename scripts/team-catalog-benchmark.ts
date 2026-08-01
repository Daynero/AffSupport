import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface CatalogBenchmarkRow {
  id: string;
  teamId: string;
  name: string;
  category: 'video' | 'image' | 'archive' | 'transcript' | 'landing' | 'other';
  geo: string | null;
  language: string | null;
  offer: string | null;
  tags: string[];
  transcriptText: string | null;
}

export interface CatalogBenchmarkFixture {
  visible: CatalogBenchmarkRow[];
  hidden: CatalogBenchmarkRow[];
}

export interface CatalogBenchmarkAdapter {
  execute: (request: CatalogBenchmarkQuery) => Promise<number> | number;
}

export interface CatalogBenchmarkQuery {
  teamId: string;
  kind: 'search' | 'filter';
  query?: string;
  filters?: {
    geo?: string;
    language?: string;
    category?: CatalogBenchmarkRow['category'];
    unfilled?: 'geo' | 'language' | 'offer';
  };
}

export interface CatalogBenchmarkStats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface CatalogBenchmarkResult {
  fixtureHash: string;
  queryManifestHash: string;
  runs: Array<CatalogBenchmarkStats & { run: number }>;
  overall: CatalogBenchmarkStats;
  search: CatalogBenchmarkStats;
  filter: CatalogBenchmarkStats;
}

const VISIBLE_TEAM_ID = '30000000-0000-4000-8000-000000000001';
const HIDDEN_TEAM_ID = '30000000-0000-4000-8000-000000000002';
const CATEGORIES = ['video', 'image', 'archive', 'transcript', 'landing', 'other'] as const;
const GEOS = ['UA', 'US', 'DE', 'BR', 'PL', null] as const;
const LANGUAGES = ['uk', 'en', 'de', 'pt-BR', 'pl', null] as const;
const OFFERS = ['Summer Sale', 'Evergreen', 'Trial', 'Retargeting', null] as const;

function benchmarkRow(index: number, teamId: string, hidden = false): CatalogBenchmarkRow {
  const category = CATEGORIES[index % CATEGORIES.length] ?? 'other';
  return {
    id: `${hidden ? 'hidden' : 'visible'}-${String(index).padStart(5, '0')}`,
    teamId,
    name: hidden ? `Secret competitor creative ${index}` : `Campaign creative ${index}`,
    category,
    geo: GEOS[index % GEOS.length] ?? null,
    language: LANGUAGES[Math.floor(index / GEOS.length) % LANGUAGES.length] ?? null,
    offer: OFFERS[Math.floor(index / 7) % OFFERS.length] ?? null,
    tags: [`batch-${index % 100}`, category, index % 11 === 0 ? 'UGC' : 'studio'],
    transcriptText: category === 'transcript' ? `multilingual launch cue ${index} campaign` : null
  };
}

export function createDeterministicCatalogFixture(): CatalogBenchmarkFixture {
  return {
    visible: Array.from({ length: 50_000 }, (_, index) => benchmarkRow(index, VISIBLE_TEAM_ID)),
    hidden: Array.from({ length: 137 }, (_, index) => benchmarkRow(index, HIDDEN_TEAM_ID, true))
  };
}

function addToIndex(index: Map<string, Set<number>>, key: string | null, row: number): void {
  if (key === null) return;
  const normalized = key.toLocaleLowerCase('en-US');
  const bucket = index.get(normalized) ?? new Set<number>();
  bucket.add(row);
  index.set(normalized, bucket);
}

export function createInMemoryCatalogAdapter(
  fixture: CatalogBenchmarkFixture
): CatalogBenchmarkAdapter {
  const rows = [...fixture.visible, ...fixture.hidden];
  const byTeam = new Map<string, Set<number>>();
  const byGeo = new Map<string, Set<number>>();
  const byLanguage = new Map<string, Set<number>>();
  const byCategory = new Map<string, Set<number>>();
  const searchTerms = new Map<string, Set<number>>();
  const missing = new Map<string, Set<number>>();

  rows.forEach((row, index) => {
    addToIndex(byTeam, row.teamId, index);
    addToIndex(byGeo, row.geo, index);
    addToIndex(byLanguage, row.language, index);
    addToIndex(byCategory, row.category, index);
    for (const field of ['geo', 'language', 'offer'] as const) {
      if (row[field] === null) addToIndex(missing, field, index);
    }
    const searchable = [row.name, row.geo, row.language, row.offer, ...row.tags, row.transcriptText]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .normalize('NFC')
      .toLocaleLowerCase('en-US');
    for (const term of new Set(searchable.split(/\s+/).filter(Boolean))) {
      addToIndex(searchTerms, term, index);
    }
  });

  function intersectionSize(first: Set<number>, others: Array<Set<number> | undefined>): number {
    let count = 0;
    outer: for (const value of first) {
      for (const other of others) {
        if (!other?.has(value)) continue outer;
      }
      count += 1;
    }
    return count;
  }

  return {
    execute(request) {
      const visible = byTeam.get(request.teamId.toLocaleLowerCase('en-US')) ?? new Set<number>();
      const predicates: Array<Set<number> | undefined> = [];
      if (request.kind === 'search' && request.query) {
        for (const term of request.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean)) {
          predicates.push(searchTerms.get(term));
        }
      }
      if (request.filters?.geo) {
        predicates.push(byGeo.get(request.filters.geo.toLocaleLowerCase('en-US')));
      }
      if (request.filters?.language) {
        predicates.push(byLanguage.get(request.filters.language.toLocaleLowerCase('en-US')));
      }
      if (request.filters?.category) {
        predicates.push(byCategory.get(request.filters.category));
      }
      if (request.filters?.unfilled) predicates.push(missing.get(request.filters.unfilled));
      return intersectionSize(visible, predicates);
    }
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function statistics(samples: number[]): CatalogBenchmarkStats {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0
  };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function queryManifest(searches: number, filterChanges: number): CatalogBenchmarkQuery[] {
  const manifest: CatalogBenchmarkQuery[] = [];
  for (let index = 0; index < searches; index += 1) {
    manifest.push({
      teamId: VISIBLE_TEAM_ID,
      kind: 'search',
      query: index % 2 === 0 ? 'campaign creative' : 'launch cue'
    });
  }
  for (let index = 0; index < filterChanges; index += 1) {
    manifest.push({
      teamId: VISIBLE_TEAM_ID,
      kind: 'filter',
      filters:
        index % 4 === 0
          ? { geo: 'UA', language: 'uk', category: 'video' }
          : index % 4 === 1
            ? { category: 'landing' }
            : index % 4 === 2
              ? { unfilled: 'geo' }
              : { geo: 'BR', category: 'transcript' }
    });
  }
  return manifest;
}

async function measure(
  adapter: CatalogBenchmarkAdapter,
  request: CatalogBenchmarkQuery
): Promise<number> {
  const started = performance.now();
  await adapter.execute(request);
  return performance.now() - started;
}

export async function benchmarkCatalogQueries(
  adapter: CatalogBenchmarkAdapter,
  options: { runs?: number; warmups?: number; searches?: number; filterChanges?: number } = {}
): Promise<CatalogBenchmarkResult> {
  const runCount = options.runs ?? 3;
  const warmups = options.warmups ?? 20;
  const searches = options.searches ?? 100;
  const filterChanges = options.filterChanges ?? 100;
  const manifest = queryManifest(searches, filterChanges);
  const all: number[] = [];
  const searchSamples: number[] = [];
  const filterSamples: number[] = [];
  const runs: CatalogBenchmarkResult['runs'] = [];

  for (let run = 1; run <= runCount; run += 1) {
    for (let warmup = 0; warmup < warmups; warmup += 1) {
      await adapter.execute(manifest[warmup % manifest.length] as CatalogBenchmarkQuery);
    }
    const runSamples: number[] = [];
    for (const request of manifest) {
      const duration = await measure(adapter, request);
      runSamples.push(duration);
      all.push(duration);
      (request.kind === 'search' ? searchSamples : filterSamples).push(duration);
    }
    runs.push({ run, ...statistics(runSamples) });
  }

  // Hash only deterministic fixture inputs. Timings are intentionally excluded.
  const fixture = createDeterministicCatalogFixture();
  return {
    fixtureHash: sha256(fixture),
    queryManifestHash: sha256(manifest),
    runs,
    overall: statistics(all),
    search: statistics(searchSamples),
    filter: statistics(filterSamples)
  };
}
