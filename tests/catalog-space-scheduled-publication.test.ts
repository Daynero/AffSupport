import { describe, expect, it, vi } from 'vitest';
import { createCatalogVideoAssignment } from '@video-compressor/shared';
import {
  catalogFeedCsv,
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../supabase/functions/_shared/catalog-feed';
import {
  CATALOG_IMAGE_COLUMN,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater';
import { PRODUCT_CATALOG_TEMPLATE, type Cell } from '../supabase/functions/_shared/product-catalog';
import { createCatalogFeedUpdater } from '../supabase/functions/catalog-updater/feed-writer';
import {
  runSpaceCatalogPublications,
  spacePublicationRowLinks
} from '../supabase/functions/catalog-updater/space-publication';
import {
  assertSpaceCatalogRequest,
  spaceCatalogDeps,
  spaceCatalogRequest,
  spaceCatalogScheduled,
  spaceCatalogVariations
} from '../supabase/functions/drive-ops/catalog-space-source';
import {
  spaceCatalogVideoAuthority,
  type SpaceVariantBinding
} from '../supabase/functions/drive-ops/catalog-space-variants';
import {
  CatalogVideoPreparationPending,
  createCatalogInitialVideoPlan,
  prepareCatalogInitialVideo
} from '../supabase/functions/drive-ops/catalog-video-generation';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';

/**
 * 057 T101: a catalog of an R2 space whose video link is published later. The request keeps the
 * dialog's protocol; the creation writes the feed with empty video cells and its link carries the
 * key that registers the scheduled policy; with variations the creation waits for them first.
 * When the job is due, the feed's own publication lane (never the Drive context) writes each row's
 * R2 address into the video column under the job's fence and verifies it; a round of the updater
 * meanwhile keeps whatever video cells the feed holds when it writes.
 */

const TEAM = '05791011-0000-4000-8000-000000000001';
const VIDEO = '05791011-0000-4000-8000-000000000002';
const FOLDER = '05791011-0000-4000-8000-000000000003';
const FEED_ROW = '05791011-0000-4000-8000-000000000004';
const ACTOR = '05791011-0000-4000-8000-000000000005';
const OPERATION = '05791011-0000-4000-8000-000000000006';
const INTENT = '05791011-0000-4000-8000-000000000007';
const JOB = '05791011-0000-4000-8000-000000000008';
const FENCE = '05791011-0000-4000-8000-000000000009';
const WORKER = '05791011-0000-4000-8000-00000000000a';
const KEY = 'product-catalog:05791011-0000-4000-8000-000000000099';
const CONTENT = 'c'.repeat(64);
const ORIGIN = 'https://catalog-videos-beta.soty.pp.ua';
const FEED = 'f'.repeat(32);
const COPY_URL = `${ORIGIN}/v/${'a'.repeat(32)}.mp4`;
const output = (index: number) =>
  `05791011-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
const url = (index: number) => `${ORIGIN}/v/${String(index).padStart(32, 'b')}.mp4`;
const VIDEO_COLUMN = catalogVideoColumnIndices()[0]!;
const ID_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');

const later = {
  mode: 'scheduled',
  localDateTime: '2026-12-01T10:00',
  timeZone: 'Europe/Kyiv',
  resolvedOffset: '+02:00',
  dueAt: '2026-12-01T08:00:00.000Z'
};
const request = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 3,
  replacesMaterialId: null,
  idempotencyKey: KEY,
  catalogVideoProtocolVersion: 1,
  restitchEnabled: false,
  videoVariationCount: 1,
  videoPublication: later,
  ...overrides
});

function memoryStore(initial?: { rows: string[][]; marker: string | null }) {
  const objects = new Map<string, { bytes: Uint8Array; marker: string | null; etag: string }>();
  let n = 0;
  if (initial)
    objects.set(`feeds/${FEED}.csv`, {
      bytes: catalogFeedCsv(initial.rows.map(row => row.map(v => ({ t: 'string', v }) as Cell))),
      marker: initial.marker,
      etag: '"seed"'
    });
  const store: CatalogFeedStore = {
    feedUrl: key => `${ORIGIN}/${key}`,
    putFeed: vi.fn(async (key: string, bytes: Uint8Array, marker: string) => {
      objects.set(key, { bytes, marker, etag: `"e${++n}"` });
      return { etag: `"e${n}"` };
    }),
    readFeed: vi.fn(async (key: string) => objects.get(key) ?? null),
    removeFeed: vi.fn(async () => undefined),
    purgeUrls: vi.fn(async () => true)
  };
  const rows = () =>
    parseCatalogFeedCsv(new TextDecoder().decode(objects.get(`feeds/${FEED}.csv`)!.bytes));
  return { store, objects, rows };
}

/** A feed of `count` products as a creation wrote it: headers, ids, empty video cells. */
function feedRows(count: number, video = ''): string[][] {
  const head = [
    PRODUCT_CATALOG_TEMPLATE.map(column => column.description),
    PRODUCT_CATALOG_TEMPLATE.map(column => column.key)
  ];
  const products = Array.from({ length: count }, (_, index) =>
    PRODUCT_CATALOG_TEMPLATE.map((column, c) =>
      c === ID_COLUMN ? `p-${index}` : c === VIDEO_COLUMN ? video : `${column.key}-${index}`
    )
  );
  return [...head, ...products];
}

describe('the request of an R2 catalog published later', () => {
  it('keeps the dialog protocol for a plain video and is admitted', () => {
    const parsed = parseCreateProductCatalogRequest(
      request({ copyVideoToR2: true, expectedExecutorId: '05791011-0000-4000-8000-0000000000ee' })
    );
    const scheduled = spaceCatalogRequest(parsed);
    expect(scheduled).toMatchObject({
      catalogVideoProtocolVersion: 1,
      restitchEnabled: false,
      videoPublication: { mode: 'scheduled', dueAt: later.dueAt }
    });
    expect(scheduled).not.toHaveProperty('copyVideoToR2');
    expect(scheduled).not.toHaveProperty('expectedExecutorId');
    expect(spaceCatalogScheduled(scheduled)).toBe(true);
    expect(spaceCatalogVariations(scheduled)).toBe(false);
    expect(() => assertSpaceCatalogRequest(scheduled)).not.toThrow();
  });

  it('keeps it with re-stitched variations too', () => {
    const scheduled = spaceCatalogRequest(
      parseCreateProductCatalogRequest(request({ restitchEnabled: true, videoVariationCount: 2 }))
    );
    expect(spaceCatalogScheduled(scheduled)).toBe(true);
    expect(spaceCatalogVariations(scheduled)).toBe(true);
    expect(() => assertSpaceCatalogRequest(scheduled)).not.toThrow();
  });

  it('a link published at once stays the plain request, as before', () => {
    const immediate = spaceCatalogRequest(
      parseCreateProductCatalogRequest(request({ videoPublication: { mode: 'immediate' } }))
    );
    expect(immediate).not.toHaveProperty('catalogVideoProtocolVersion');
    expect(spaceCatalogScheduled(immediate)).toBe(false);
  });
});

describe('the creation of an R2 catalog published later', () => {
  function setup(options: { variationLinks?: string[] } = {}) {
    const bucket = memoryStore();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      calls.push([name, parameters]);
      switch (name) {
        case 'service_space_catalog_material':
          return parameters.p_material === FOLDER
            ? {
                id: FOLDER,
                name: 'Shop',
                kind: 'folder',
                category: null,
                mimeType: null,
                parentFolderId: null,
                sizeBytes: null,
                contentId: null
              }
            : {
                id: VIDEO,
                name: 'clip.mp4',
                kind: 'file',
                category: 'video',
                mimeType: 'video/mp4',
                parentFolderId: FOLDER,
                sizeBytes: '5000',
                contentId: CONTENT
              };
        case 'service_space_catalog_video_link':
          return { url: COPY_URL, copyId: OPERATION, state: 'planned', sourceVersion: CONTENT };
        case 'service_catalog_video_r2_kick':
          return null;
        case 'service_space_catalog_names':
          return [];
        case 'service_commit_space_catalog_feed':
          return { materialId: FEED_ROW, reused: false };
        case 'service_link_space_catalog_feed':
          return { linked: true, retired: [], variant: 1 };
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    });
    const space = spaceCatalogDeps({
      rpc,
      feeds: bucket.store,
      signal: new AbortController().signal,
      log: vi.fn(),
      publicationKey: KEY,
      ...(options.variationLinks
        ? {
            variationSet: () => '05791011-0000-4000-8000-0000000000aa',
            variationLinks: () => options.variationLinks!
          }
        : {})
    });
    const deps = {
      readSettings: vi.fn(async () => ({
        title: 'Polo',
        description: 'Knit',
        imageLink: 'https://catalog-images.soty.pp.ua/i/a.jpg',
        priceMin: 10,
        priceMax: 10
      })),
      drawTexts: vi.fn(async () => []),
      drawImages: vi.fn(async () => []),
      readLiveCatalogs: vi.fn(async () => []),
      nextVariant: vi.fn(async () => 1),
      startOperation: vi.fn(async () => ({
        operationId: OPERATION,
        state: 'pending' as const,
        reused: false
      })),
      markRunning: vi.fn(async () => undefined),
      failOperation: vi.fn(async () => undefined),
      log: vi.fn(),
      ...space,
      videoDelivery: { kind: 'deferred' as const }
    } as ProductCatalogDeps;
    return { deps, calls, bucket };
  }

  it('writes empty video cells and links with the key that registers the policy', async () => {
    const f = setup();
    const result = await createProductCatalog(f.deps, request(), ACTOR);
    expect(result).toMatchObject({ outcome: 'created', catalog: { materialId: FEED_ROW } });
    const csv = parseCatalogFeedCsv(
      new TextDecoder().decode([...f.bucket.objects.values()][0]!.bytes)
    );
    expect(csv).toHaveLength(5);
    csv.slice(2).forEach(row => {
      expect(row[VIDEO_COLUMN]).toBe('');
      expect(row.some(cell => cell.includes('drive.google.com'))).toBe(false);
    });
    const linked = f.calls.find(([name]) => name === 'service_link_space_catalog_feed')![1];
    expect(linked.p_record).toMatchObject({ spacePublicationKey: KEY, videoLink: COPY_URL });
  });

  it('with variations links the set and names a variation, never a copy of the original', async () => {
    const f = setup({ variationLinks: [url(0), url(1), url(0)] });
    await createProductCatalog(
      f.deps,
      request({ restitchEnabled: true, videoVariationCount: 2 }),
      ACTOR
    );
    expect(f.calls.map(([name]) => name)).not.toContain('service_space_catalog_video_link');
    const linked = f.calls.find(([name]) => name === 'service_link_space_catalog_feed')![1];
    expect(linked.p_record).toMatchObject({
      spacePublicationKey: KEY,
      spaceVariantSetId: '05791011-0000-4000-8000-0000000000aa',
      videoLink: url(0)
    });
  });
});

describe('the video authority of an R2 catalog published later', () => {
  const effectiveDefaults = {
    operation: 'restitch',
    startImageIds: [],
    endImageIds: [],
    fitMode: 'cover',
    startEnabled: true,
    endEnabled: true,
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: 2700,
    sourceMode: 'drive',
    builtin: { version: 1, start: true, end: true },
    configured: true,
    updatedAt: null,
    updatedBy: null
  };
  const plan = () =>
    createCatalogInitialVideoPlan(
      parseCreateProductCatalogRequest(
        request({ restitchEnabled: true, videoVariationCount: 2 })
      ) as never,
      3,
      Date.parse('2026-11-28T10:00:00Z')
    );
  function rpc(state: 'preparing' | 'ready') {
    return vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      switch (name) {
        case 'service_space_catalog_variant_defaults':
          return effectiveDefaults;
        case 'service_admit_space_catalog_variants':
          return {
            setId: parameters.p_set,
            state,
            requestedCount: 2,
            registeredCount: state === 'ready' ? 2 : 1,
            variants: []
          };
        case 'service_space_catalog_variant_outputs':
          return [0, 1].map(index => ({ index, materialId: output(index) }));
        case 'service_space_catalog_video_link': {
          const index = Number(String(parameters.p_material).slice(-2));
          return { url: url(index), copyId: output(index), state: 'ready', sourceVersion: CONTENT };
        }
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    });
  }

  it('waits for every variation before the catalog is made', async () => {
    const binding: SpaceVariantBinding = { setId: null };
    const authority = spaceCatalogVideoAuthority({
      rpc: rpc('preparing'),
      teamId: TEAM,
      actorId: ACTOR,
      sourceMaterialId: VIDEO,
      binding
    });
    const pending = prepareCatalogInitialVideo(authority, INTENT, plan());
    await expect(pending).rejects.toBeInstanceOf(CatalogVideoPreparationPending);
    await expect(pending).rejects.toMatchObject({
      result: { outcome: 'preparing_video', registeredCount: 1, requestedCount: 2 }
    });
    expect(binding.setId).toBeNull();
  });

  it('then hands the creation empty cells and keeps the rows’ variations for the link', async () => {
    const binding: SpaceVariantBinding = { setId: null };
    const p = plan();
    const authority = spaceCatalogVideoAuthority({
      rpc: rpc('ready'),
      teamId: TEAM,
      actorId: ACTOR,
      sourceMaterialId: VIDEO,
      binding
    });
    expect(await prepareCatalogInitialVideo(authority, INTENT, p)).toEqual({ kind: 'deferred' });
    expect(binding.setId).toBe(p.setId);
    expect(binding.videoLinks).toHaveLength(3);
  });
});

describe('the publication lane of R2 catalogs', () => {
  function service(options: {
    context?: Record<string, unknown>;
    state?: 'waiting' | 'applying';
    claim?: boolean;
  }) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let state = options.state ?? 'waiting';
    const settled: unknown[] = [];
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      calls.push([name, parameters]);
      switch (name) {
        case 'service_claim_space_catalog_publication_jobs':
          return {
            data: {
              serverNow: Date.parse('2026-12-01T08:00:30Z'),
              items:
                options.claim === false
                  ? []
                  : [
                      {
                        jobId: JOB,
                        teamId: TEAM,
                        actorId: ACTOR,
                        catalogId: FEED_ROW,
                        policy: {
                          mode: 'scheduled',
                          revision: 1,
                          dueAt: later.dueAt,
                          timeZone: 'Europe/Kyiv'
                        },
                        job: {
                          revision: 1,
                          writerFence: state === 'applying' ? FENCE : null,
                          state,
                          target: {
                            kind: 'source',
                            materialId: VIDEO,
                            sourceVersion: `space-v1:${CONTENT}`
                          }
                        },
                        active: null
                      }
                    ]
            },
            error: null
          };
        case 'service_space_catalog_publication_context':
          return {
            data: options.context ?? {
              state: 'ready',
              feedId: FEED,
              productCount: 3,
              sources: [{ materialId: VIDEO, url: COPY_URL, sourceVersion: CONTENT, ready: true }]
            },
            error: null
          };
        case 'service_reserve_catalog_publication':
          return { data: FENCE, error: null };
        case 'service_dispatch_catalog_publication':
          state = 'applying';
          return { data: true, error: null };
        case 'service_settle_catalog_publication':
          settled.push(parameters);
          return { data: true, error: null };
        case 'service_defer_catalog_publication':
          return { data: true, error: null };
        case 'service_catalog_video_r2_kick':
          return { data: null, error: null };
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    });
    return { service: { rpc }, calls, settled };
  }

  it('does nothing without the feed store', async () => {
    const f = service({});
    expect(
      await runSpaceCatalogPublications({ service: f.service, workerId: WORKER, store: null })
    ).toEqual({ enabled: false });
    expect(f.service.rpc).not.toHaveBeenCalled();
  });

  it('writes the copy’s address into every row under the job’s fence and verifies it', async () => {
    const f = service({});
    const bucket = memoryStore({ rows: feedRows(3), marker: 'creation' });
    const result = await runSpaceCatalogPublications({
      service: f.service,
      workerId: WORKER,
      store: bucket.store
    });
    expect(result).toMatchObject({ enabled: true, claimed: 1, verified: 1 });
    expect(
      bucket
        .rows()
        .slice(2)
        .map(row => row[VIDEO_COLUMN])
    ).toEqual([COPY_URL, COPY_URL, COPY_URL]);
    expect(bucket.objects.get(`feeds/${FEED}.csv`)!.marker).toBe(FENCE);
    // Only the video column moved.
    expect(
      bucket
        .rows()
        .slice(2)
        .map(row => row[ID_COLUMN])
    ).toEqual(['p-0', 'p-1', 'p-2']);
    expect(f.settled).toEqual([
      expect.objectContaining({ p_job: JOB, p_fence: FENCE, p_outcome: 'verified' })
    ]);
    const names = f.calls.map(([name]) => name);
    expect(names).not.toContain('service_claim_catalog_publication_jobs');
    expect(names).not.toContain('service_catalog_publication_cells_context');
    expect(names).not.toContain('service_prepare_catalog_publication_cells');
  });

  it('waits while a copy is not ready, and nudges the copy worker', async () => {
    const f = service({
      context: {
        state: 'waiting',
        feedId: FEED,
        productCount: 3,
        sources: [{ materialId: VIDEO, url: COPY_URL, sourceVersion: CONTENT, ready: false }]
      }
    });
    const bucket = memoryStore({ rows: feedRows(3), marker: 'creation' });
    const result = await runSpaceCatalogPublications({
      service: f.service,
      workerId: WORKER,
      store: bucket.store
    });
    expect(result).toMatchObject({ claimed: 1, waiting: 1, verified: 0 });
    expect(f.calls.map(([name]) => name)).toContain('service_catalog_video_r2_kick');
    expect(bucket.store.putFeed).not.toHaveBeenCalled();
  });

  it('reconciles a write it lost track of: absent when the feed does not hold it', async () => {
    const f = service({ state: 'applying' });
    const bucket = memoryStore({ rows: feedRows(3), marker: 'a-later-round' });
    await runSpaceCatalogPublications({
      service: f.service,
      workerId: WORKER,
      store: bucket.store
    });
    expect(f.settled).toEqual([expect.objectContaining({ p_outcome: 'absent' })]);
    expect(bucket.store.putFeed).not.toHaveBeenCalled();
  });

  it('gives every row its variation by the plan’s assignment', () => {
    const recipeRowIds = [0, 1, 2, 3].map(n => `05791011-0000-4000-8000-0000000002${n}0`);
    const seed = 'e'.repeat(64);
    const links = spacePublicationRowLinks({
      productCount: 5,
      sources: [0, 1].map(index => ({ materialId: output(index), url: url(index) })),
      recipeRowIds,
      assignmentSeed: seed
    });
    const assignment = createCatalogVideoAssignment({
      recipeRevision: 1,
      recipeRowIds,
      variantCount: 2,
      seed
    });
    const byRow = new Map(
      assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
    );
    expect(links.slice(0, 4)).toEqual(recipeRowIds.map(row => url(byRow.get(row)!)));
    // A row added since the creation takes the variations in turn.
    expect(links[4]).toBe(url(4 % 2));
    expect(
      spacePublicationRowLinks({
        productCount: 2,
        sources: [{ materialId: VIDEO, url: COPY_URL }]
      })
    ).toEqual([COPY_URL, COPY_URL]);
  });
});

describe('the publication lane of an R2 catalog of several creatives (T117)', () => {
  const image = (n: number) =>
    `https://catalog-images.soty.pp.ua/c1/05791011-0000-4000-8000-00000000030${n}`;
  function lane(context: Record<string, unknown>) {
    const settled: unknown[] = [];
    let state = 'waiting';
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      switch (name) {
        case 'service_claim_space_catalog_publication_jobs':
          return {
            data: {
              serverNow: Date.parse('2026-12-01T08:00:30Z'),
              items: [
                {
                  jobId: JOB,
                  teamId: TEAM,
                  actorId: ACTOR,
                  catalogId: FEED_ROW,
                  policy: {
                    mode: 'scheduled',
                    revision: 1,
                    dueAt: later.dueAt,
                    timeZone: 'Europe/Kyiv'
                  },
                  job: {
                    revision: 1,
                    writerFence: state === 'applying' ? FENCE : null,
                    state,
                    target: { kind: 'creatives', segments: [] }
                  },
                  active: null
                }
              ]
            },
            error: null
          };
        case 'service_space_catalog_publication_context':
          return { data: context, error: null };
        case 'service_reserve_catalog_publication':
          return { data: FENCE, error: null };
        case 'service_dispatch_catalog_publication':
          state = 'applying';
          return { data: true, error: null };
        case 'service_settle_catalog_publication':
          settled.push(parameters);
          return { data: true, error: null };
        case 'service_defer_catalog_publication':
        case 'service_catalog_video_r2_kick':
          return { data: true, error: null };
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    });
    return { service: { rpc }, settled };
  }
  const segment = (
    ordinal: number,
    kind: 'video' | 'image',
    rowStart: number,
    rowCount: number,
    urls: string[],
    extra: Record<string, unknown> = {}
  ) => ({
    ordinal,
    kind,
    rowStart,
    rowCount,
    sources: urls.map((address, index) => ({
      materialId: output(ordinal * 10 + index),
      url: address,
      sourceVersion: CONTENT,
      ready: true
    })),
    ...extra
  });
  const context = (kind: 'video' | 'image', segments: unknown[]) => ({
    state: 'ready',
    feedId: FEED,
    productCount: 3,
    creativeKind: kind,
    sources: (segments as Array<{ sources: unknown[] }>).flatMap(s => s.sources),
    segments
  });

  it('writes each creative’s own copy into its block of rows', async () => {
    const f = lane(
      context('video', [segment(0, 'video', 0, 2, [url(1)]), segment(1, 'video', 2, 1, [url(2)])])
    );
    const bucket = memoryStore({ rows: feedRows(3), marker: 'creation' });
    const result = await runSpaceCatalogPublications({
      service: f.service,
      workerId: WORKER,
      store: bucket.store
    });
    expect(result).toMatchObject({ claimed: 1, verified: 1 });
    expect(
      bucket
        .rows()
        .slice(2)
        .map(row => row[VIDEO_COLUMN])
    ).toEqual([url(1), url(1), url(2)]);
    expect(f.settled).toEqual([expect.objectContaining({ p_outcome: 'verified' })]);
  });

  it('writes a picture catalog’s pictures into H and leaves its video column', async () => {
    const f = lane(
      context('image', [
        segment(0, 'image', 0, 2, [image(1)]),
        segment(1, 'image', 2, 1, [image(2)])
      ])
    );
    const bucket = memoryStore({ rows: feedRows(3), marker: 'creation' });
    await runSpaceCatalogPublications({
      service: f.service,
      workerId: WORKER,
      store: bucket.store
    });
    const rows = bucket.rows().slice(2);
    expect(rows.map(row => row[CATALOG_IMAGE_COLUMN])).toEqual([image(1), image(1), image(2)]);
    expect(rows.map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    expect(f.settled).toEqual([expect.objectContaining({ p_outcome: 'verified' })]);
  });

  it('gives each re-stitched video’s rows its own variations by its segment’s seed', () => {
    const rows = ['05791011-0000-4000-8000-000000000210', '05791011-0000-4000-8000-000000000220'];
    const seed = 'a'.repeat(64);
    const links = spacePublicationRowLinks({
      productCount: 3,
      sources: [],
      segments: [
        segment(0, 'video', 0, 2, [url(1), url(2)], { assignmentSeed: seed, recipeRowIds: rows }),
        segment(1, 'video', 2, 1, [url(3)])
      ]
    });
    const assignment = createCatalogVideoAssignment({
      recipeRevision: 1,
      recipeRowIds: rows,
      variantCount: 2,
      seed
    });
    const byRow = new Map(
      assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
    );
    expect(links).toEqual([...rows.map(row => [url(1), url(2)][byRow.get(row)!]!), url(3)]);
  });

  it('refuses blocks that do not cover the rows or addresses of another kind', () => {
    expect(() =>
      spacePublicationRowLinks({
        productCount: 3,
        sources: [],
        segments: [segment(0, 'video', 0, 2, [url(1)])]
      })
    ).toThrow(expect.objectContaining({ code: 'PROCESS_RESULT_UNCERTAIN' }));
    expect(() =>
      spacePublicationRowLinks({
        productCount: 3,
        sources: [],
        segments: [segment(0, 'image', 0, 3, [url(1)])]
      })
    ).toThrow(expect.objectContaining({ code: 'PROCESS_RESULT_UNCERTAIN' }));
    expect(() =>
      spacePublicationRowLinks({
        productCount: 3,
        sources: [],
        segments: [segment(0, 'video', 0, 3, [url(1), url(2)])]
      })
    ).toThrow(expect.objectContaining({ code: 'PROCESS_RESULT_UNCERTAIN' }));
  });
});

describe('a round of the updater on a feed with a publication', () => {
  it('keeps the video cells the feed holds when it writes, not the ones it read', async () => {
    const bucket = memoryStore({ rows: feedRows(2), marker: 'creation' });
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_prepare_catalog_nonvideo_update_context')
        return {
          data: { contextToken: 'a'.repeat(64), currentProductCount: 2, productCount: 2 },
          error: null
        };
      return { data: null, error: null };
    });
    const updater = createCatalogFeedUpdater({
      store: bucket.store,
      service: { rpc } as never,
      workerId: WORKER,
      signal: new AbortController().signal,
      log: vi.fn()
    });
    const item = { catalogId: FEED_ROW, productCount: 2, feed: { feedId: FEED, revision: 1 } };
    const prepared = await updater.prepareNonVideoUpdate(item as never);
    expect(prepared.videoCells).toEqual(['', '']);
    // The publication lands while the round builds its rows.
    const published = feedRows(2, COPY_URL);
    bucket.objects.set(`feeds/${FEED}.csv`, {
      bytes: catalogFeedCsv(published.map(row => row.map(v => ({ t: 'string', v }) as Cell))),
      marker: FENCE,
      etag: '"p"'
    });
    const built = feedRows(2).map(row => row.map(v => ({ t: 'string', v }) as Cell));
    built[2]![3] = { t: 'string', v: 'renamed' };
    await prepared.write(built, 'round-2');
    const rows = bucket.rows();
    expect(rows.slice(2).map(row => row[VIDEO_COLUMN])).toEqual([COPY_URL, COPY_URL]);
    expect(rows[2]![3]).toBe('renamed');
  });

  it('keeps the pictures a picture catalog’s publication wrote into H (T117)', async () => {
    const bucket = memoryStore({ rows: feedRows(2), marker: 'creation' });
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_prepare_catalog_nonvideo_update_context')
        return {
          data: { contextToken: 'a'.repeat(64), currentProductCount: 2, productCount: 2 },
          error: null
        };
      return { data: null, error: null };
    });
    const updater = createCatalogFeedUpdater({
      store: bucket.store,
      service: { rpc } as never,
      workerId: WORKER,
      signal: new AbortController().signal,
      log: vi.fn()
    });
    const item = {
      catalogId: FEED_ROW,
      productCount: 2,
      feed: { feedId: FEED, revision: 1 },
      creatives: { kind: 'image' }
    };
    const prepared = await updater.prepareNonVideoUpdate(item as never);
    expect(prepared.imageCells).toHaveLength(2);
    const picture = 'https://catalog-images.soty.pp.ua/c1/05791011-0000-4000-8000-000000000301';
    const published = feedRows(2).map(row => [...row]);
    for (const row of published.slice(2)) row[CATALOG_IMAGE_COLUMN] = picture;
    bucket.objects.set(`feeds/${FEED}.csv`, {
      bytes: catalogFeedCsv(published.map(row => row.map(v => ({ t: 'string', v }) as Cell))),
      marker: FENCE,
      etag: '"p"'
    });
    const built = feedRows(2).map(row => row.map(v => ({ t: 'string', v }) as Cell));
    await prepared.write(built, 'round-2');
    expect(
      bucket
        .rows()
        .slice(2)
        .map(row => row[CATALOG_IMAGE_COLUMN])
    ).toEqual([picture, picture]);
  });
});
