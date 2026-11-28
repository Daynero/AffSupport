import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { catalogFeedCsv, parseCatalogFeedCsv } from '../supabase/functions/_shared/catalog-feed';
import {
  buildProductCatalogRows,
  PRODUCT_CATALOG_TEMPLATE
} from '../supabase/functions/_shared/product-catalog';
import {
  CATALOG_IMAGE_COLUMN,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater';
import {
  CatalogVideoR2,
  type CatalogVideoR2Config
} from '../supabase/functions/_shared/r2-catalog-video';
import {
  applyFeedPublicationCells,
  createCatalogFeedUpdater,
  verifyFeedPublicationCells
} from '../supabase/functions/catalog-updater/feed-writer';
import {
  parseClaimedCatalog,
  runCatalogUpdaterTick,
  type CatalogUpdaterDeps
} from '../supabase/functions/catalog-updater/worker';

/**
 * 057 T038: the updater on a catalog of an R2 space. The round rebuilds the rows exactly as for
 * a sheet and then writes the whole feed: no Sheets budget, no Drive client, no Drive file read.
 * A non-video round keeps the links the feed holds; a video publication patches the feed.
 */

const FEED = 'c'.repeat(32);
const KEY = `feeds/${FEED}.csv`;
const VIDEO_COLUMN = catalogVideoColumnIndices()[0]!;
const ID_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');
const config: CatalogVideoR2Config = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'soty-catalog-videos-dev-staging',
  publicBucket: 'soty-catalog-videos-dev-public',
  publicOrigin: 'https://catalog-videos-dev.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'not-a-real-token',
  partVerification: 'readback'
};
const signer = { sign: async (request: Request) => request };

function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; marker: string | null; etag: string }>();
  let n = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.host === 'api.cloudflare.com')
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    const key = url.pathname.split('/').slice(2).join('/');
    if (request.method === 'PUT') {
      objects.set(key, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        marker: request.headers.get('x-amz-meta-soty-feed-attempt'),
        etag: `"e${++n}"`
      });
      return new Response(null, { status: 200, headers: { etag: `"e${n}"` } });
    }
    const held = objects.get(key);
    if (!held) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(held.bytes), {
      status: 200,
      headers: { etag: held.etag, 'x-amz-meta-soty-feed-attempt': held.marker ?? '' }
    });
  };
  return { r2: new CatalogVideoR2(config, signer, fetcher), objects };
}

const PUBLISHED = 'https://catalog-videos-dev.test/v/' + 'd'.repeat(32) + '.mp4';

/** The feed as the catalog's creation wrote it: three products, published video links. */
function seed(store: ReturnType<typeof bucket>, marker = 'seed') {
  let id = 0;
  const rows = buildProductCatalogRows({
    settings: {
      title: 'Polo',
      description: 'Knit',
      imageLink: 'https://img.test/a.png',
      price: 10
    },
    sourceLink: 'https://offer.example.test/?sub=1',
    videoLink: PUBLISHED,
    count: 3,
    randomLinkVariation: false,
    // What a publication wrote: each product its own link, none of them the catalog's.
    videoDelivery: { kind: 'assigned', videoLinks: [1, 2, 3].map(n => `${PUBLISHED}?p=${n}`) },
    newId: () => `old-${++id}`
  });
  store.objects.set(KEY, { bytes: catalogFeedCsv(rows), marker, etag: '"seed"' });
}

function feedRow(overrides: Record<string, unknown> = {}) {
  return {
    catalog_material_id: 'feed-catalog',
    team_id: 'team',
    attempts: 1,
    update_count: 0,
    product_count: 3,
    source_link: 'https://offer.example.test/?sub=1',
    video_link: PUBLISHED,
    settings_snapshot: {
      title: 'Polo',
      description: 'Knit',
      price: 10,
      imageLink: 'https://img.test/a.png'
    },
    drive_file_id: null,
    resource_key: null,
    credential_id: null,
    feed_id: FEED,
    feed_revision: 4,
    ...overrides
  };
}

function setup(
  options: { rows?: unknown[]; legacyVideo?: boolean; variantLinks?: string[] | null } = {}
) {
  const store = bucket();
  seed(store);
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    // 057 T097: only a catalog of re-stitched variations has links here; every other feed null.
    if (name === 'service_space_catalog_variant_links')
      return { data: options.variantLinks ?? null, error: null };
    if (name === 'service_prepare_catalog_nonvideo_update_context')
      return {
        data: {
          contextToken: 'f'.repeat(64),
          currentProductCount: 3,
          productCount: 3,
          credentialId: null,
          rootFolderId: null,
          fileId: null
        },
        error: null
      };
    if (name === 'service_record_catalog_feed')
      return { data: { feedRevision: String(Number(args.p_expected_revision) + 1) }, error: null };
    return { data: null, error: { message: 'unexpected' } };
  });
  const batches = [options.rows ?? [feedRow()]];
  const drive = {
    getFile: vi.fn(),
    updateConvertedFile: vi.fn(),
    listAnyonePermissions: vi.fn(),
    createAnyoneReaderPermission: vi.fn()
  };
  const deps = {
    workerId: 'worker',
    feeds: createCatalogFeedUpdater({
      store: store.r2,
      service: { rpc } as never,
      workerId: 'worker',
      signal: new AbortController().signal,
      log: vi.fn()
    }),
    ...(options.legacyVideo === false
      ? { authorizeLegacyVideoWrite: vi.fn(async () => false), prepareNonVideoUpdate: vi.fn() }
      : {}),
    takeSheetsReads: vi.fn(async () => 0),
    openRounds: vi.fn(async () => 1),
    claim: vi.fn(async () => batches.shift() ?? []),
    driveFor: vi.fn(async () => drive),
    progress: vi.fn(async () => true),
    beginWrite: vi.fn(async () => true),
    finishWrite: vi.fn(async () => true),
    recordChanges: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    unknown: vi.fn(async () => true),
    markNeedsReauth: vi.fn(async () => undefined),
    claimRetired: vi.fn(async () => []),
    authorizeCleanup: vi.fn(async () => true),
    forgetCopy: vi.fn(async () => true),
    now: () => 0,
    log: vi.fn()
  } as unknown as CatalogUpdaterDeps;
  const feedRows = () =>
    parseCatalogFeedCsv(new TextDecoder().decode(store.objects.get(KEY)!.bytes));
  return { deps, store, rpc, drive, feedRows };
}

describe('a feed catalog in the claim', () => {
  it('parses without Drive fields; a Drive row parses as before', () => {
    expect(parseClaimedCatalog(feedRow())).toMatchObject({
      catalogId: 'feed-catalog',
      driveFileId: '',
      credentialId: '',
      feed: { feedId: FEED, revision: 4 }
    });
    expect(parseClaimedCatalog(feedRow({ feed_id: 'not-a-feed' }))).toBeNull();
    const drive = parseClaimedCatalog(
      feedRow({
        drive_file_id: 'sheet',
        credential_id: 'cred',
        feed_id: undefined,
        feed_revision: undefined
      })
    );
    expect(drive).not.toHaveProperty('feed');
    expect(drive).toMatchObject({ driveFileId: 'sheet', credentialId: 'cred' });
    expect(parseClaimedCatalog(feedRow({ feed_id: null, feed_revision: null }))).toBeNull();
  });
});

describe('an update of a feed catalog', () => {
  it('writes the rebuilt rows as the whole feed, with no Sheets read and no Drive call', async () => {
    const f = setup();
    const summary = await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ updated: 1, failed: 0 });
    expect(f.deps.takeSheetsReads).not.toHaveBeenCalled();
    expect(f.deps.driveFor).not.toHaveBeenCalled();
    expect(f.drive.getFile).not.toHaveBeenCalled();
    const rows = f.feedRows();
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual(PRODUCT_CATALOG_TEMPLATE.map(column => column.key));
    // New product ids, one update on: the round rebuilt them.
    expect(rows.slice(2).map(row => row[ID_COLUMN])).not.toContain('old-1');
    // A legacy round writes the catalog's own link again, as it does into a sheet.
    for (const row of rows.slice(2)) {
      expect(row[VIDEO_COLUMN]!.startsWith(PUBLISHED)).toBe(true);
      expect(row[VIDEO_COLUMN]).not.toContain('?p=');
    }
    const marker = vi.mocked(f.deps.beginWrite).mock.calls[0]![1].marker;
    expect(f.store.objects.get(KEY)!.marker).toBe(marker);
    expect(vi.mocked(f.deps.beginWrite).mock.calls[0]![1].baselineVersion).toBe('4');
    expect(f.rpc).toHaveBeenCalledWith('service_record_catalog_feed', {
      p_catalog: 'feed-catalog',
      p_feed_id: FEED,
      p_bytes: f.store.objects.get(KEY)!.bytes.byteLength,
      p_expected_revision: 4
    });
    expect(f.deps.complete).toHaveBeenCalledWith('feed-catalog', 1, null, expect.anything());
  });

  it('a non-video round keeps the published links the feed holds, and writes the feed', async () => {
    const f = setup({ legacyVideo: false });
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.prepareNonVideoUpdate).not.toHaveBeenCalled();
    expect(f.deps.takeSheetsReads).not.toHaveBeenCalled();
    expect(f.deps.driveFor).not.toHaveBeenCalled();
    expect(vi.mocked(f.deps.beginWrite).mock.calls[0]![1].nonVideoContextToken).toBe(
      'f'.repeat(64)
    );
    expect(
      f
        .feedRows()
        .slice(2)
        .map(row => row[VIDEO_COLUMN])
    ).toEqual([1, 2, 3].map(n => `${PUBLISHED}?p=${n}`));
    expect(f.deps.complete).toHaveBeenCalled();
  });

  it('a catalog of re-stitched variations keeps each row’s variation in a legacy round (T097)', async () => {
    const variations = [1, 2, 3].map(
      n => `https://catalog-videos-dev.test/v/${String(n).repeat(32)}.mp4`
    );
    const f = setup({ variantLinks: variations });
    const resolveVideoLink = vi.fn();
    (f.deps as { resolveVideoLink?: unknown }).resolveVideoLink = resolveVideoLink;
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.complete).toHaveBeenCalled();
    expect(resolveVideoLink).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('service_space_catalog_variant_links', {
      p_catalog: 'feed-catalog'
    });
    expect(
      f
        .feedRows()
        .slice(2)
        .map(row => row[VIDEO_COLUMN])
    ).toEqual([1, 2, 3].map(n => `${PUBLISHED}?p=${n}`));
  });

  it('rows a round adds take the variations in turn after the ones there (T097)', async () => {
    const variations = [1, 2].map(
      n => `https://catalog-videos-dev.test/v/${String(n).repeat(32)}.mp4`
    );
    const f = setup({ variantLinks: variations });
    const item = parseClaimedCatalog(feedRow())!;
    const cells = await f.deps.feeds!.variantCells!(item, 6);
    expect(cells).toEqual([
      ...[1, 2, 3].map(n => `${PUBLISHED}?p=${n}`),
      variations[1],
      variations[0],
      variations[1]
    ]);
    const plain = setup();
    expect(await plain.deps.feeds!.variantCells!(item, 3)).toBeNull();
    const broken = setup({ variantLinks: ['https://elsewhere.test/v.mp4'] });
    await expect(broken.deps.feeds!.variantCells!(item, 3)).rejects.toMatchObject({
      code: 'PROCESS_RESULT_UNCERTAIN'
    });
  });

  // 057 T103: a Launch's catalog of several videos or of pictures in an R2 space.
  const creatives = (kind: 'video' | 'image', count: number) => ({
    _catalogCreativeKind: kind,
    _catalogCreatives: Array.from({ length: count }, (_, ordinal) => ({
      ordinal,
      materialId: `0579103${ordinal}-0000-4000-8000-000000000001`,
      alias: `c${ordinal}`,
      kind,
      link:
        kind === 'image'
          ? `https://catalog-images.test/c1/0579103${ordinal}-0000-4000-8000-000000000001`
          : `https://catalog-videos-dev.test/v/${String(ordinal + 5).repeat(32)}.mp4`,
      linkKind: 'r2'
    })),
    _catalogRowCreatives: count === 1 ? [0, 0, 0] : [0, 0, 1]
  });
  const snapshot = (extra: Record<string, unknown>) => ({
    settings_snapshot: {
      title: 'Polo',
      description: 'Knit',
      price: 10,
      imageLink: 'https://img.test/a.png',
      ...extra
    }
  });

  it('a catalog of several videos keeps each block’s own video in a round (T103)', async () => {
    const f = setup({ rows: [feedRow(snapshot(creatives('video', 2)))] });
    const resolveVideoLink = vi.fn();
    (f.deps as { resolveVideoLink?: unknown }).resolveVideoLink = resolveVideoLink;
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.complete).toHaveBeenCalled();
    // One link resolved for the catalog would be written over both blocks.
    expect(resolveVideoLink).not.toHaveBeenCalled();
    expect(f.drive.getFile).not.toHaveBeenCalled();
    expect(
      f
        .feedRows()
        .slice(2)
        .map(row => row[VIDEO_COLUMN])
    ).toEqual([1, 2, 3].map(n => `${PUBLISHED}?p=${n}`));
    expect(
      f
        .feedRows()
        .slice(2)
        .map(row => row[ID_COLUMN]!.split('-')[0])
    ).toEqual(['c0', 'c0', 'c1']);
  });

  it('a catalog of several videos is not grown: one block would take the other’s rows (T103)', async () => {
    const f = setup({ rows: [feedRow(snapshot(creatives('video', 2)))] });
    const item = parseClaimedCatalog(feedRow(snapshot(creatives('video', 2))))!;
    expect(await f.deps.feeds!.creativeCells!(item, 4)).toBeNull();
    expect(await f.deps.feeds!.creativeCells!(item, 3)).toEqual(
      [1, 2, 3].map(n => `${PUBLISHED}?p=${n}`)
    );
    const single = parseClaimedCatalog(feedRow(snapshot(creatives('video', 1))))!;
    expect(await f.deps.feeds!.creativeCells!(single, 3)).toBeNull();
  });

  it('a picture catalog keeps its pictures and no video in a round (T103)', async () => {
    const f = setup({ rows: [feedRow(snapshot(creatives('image', 2)))] });
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.complete).toHaveBeenCalled();
    const rows = f.feedRows().slice(2);
    expect(rows.map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    expect(rows.map(row => row[CATALOG_IMAGE_COLUMN])).toEqual([
      'https://catalog-images.test/c1/05791030-0000-4000-8000-000000000001',
      'https://catalog-images.test/c1/05791030-0000-4000-8000-000000000001',
      'https://catalog-images.test/c1/05791031-0000-4000-8000-000000000001'
    ]);
    const item = parseClaimedCatalog(feedRow(snapshot(creatives('image', 1))))!;
    expect(await f.deps.feeds!.creativeCells!(item, 5)).toEqual(['', '', '', '', '']);
  });

  it('a feed that no longer reads as the catalog stops the round before any write', async () => {
    const f = setup({ legacyVideo: false });
    f.store.objects.set(KEY, {
      bytes: new TextEncoder().encode('a,b\r\nc,d'),
      marker: null,
      etag: '"x"'
    });
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.beginWrite).not.toHaveBeenCalled();
    expect(f.deps.complete).not.toHaveBeenCalled();
  });

  it('a readback with another marker is an unknown result, never a success', async () => {
    const f = setup();
    const original = f.store.r2.readFeed.bind(f.store.r2);
    f.store.r2.readFeed = async (key, signal) => {
      const held = await original(key, signal);
      return held && { ...held, marker: 'someone-else' };
    };
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.unknown).toHaveBeenCalledWith('feed-catalog', 'DELIVERY_UNAVAILABLE');
    expect(f.deps.complete).not.toHaveBeenCalled();
  });

  it('without a feed writer the round waits instead of reaching for Drive', async () => {
    const f = setup();
    delete (f.deps as { feeds?: unknown }).feeds;
    await runCatalogUpdaterTick(f.deps, { budgetMs: 8000 });
    expect(f.deps.driveFor).not.toHaveBeenCalled();
    expect(f.deps.retry).toHaveBeenCalledWith(
      'feed-catalog',
      'STORAGE_UNAVAILABLE',
      expect.any(Date)
    );
  });
});

describe('a video publication into a feed', () => {
  const signal = new AbortController().signal;
  const frozen = (overrides: Record<string, unknown> = {}) => ({
    feedId: FEED,
    idColumn: ID_COLUMN,
    videoColumn: VIDEO_COLUMN,
    idHeaders: [
      PRODUCT_CATALOG_TEMPLATE[ID_COLUMN]!.description,
      PRODUCT_CATALOG_TEMPLATE[ID_COLUMN]!.key
    ] as [string, string],
    videoHeaders: [
      PRODUCT_CATALOG_TEMPLATE[VIDEO_COLUMN]!.description,
      PRODUCT_CATALOG_TEMPLATE[VIDEO_COLUMN]!.key
    ] as [string, string],
    products: [1, 2, 3].map(n => ({
      id: `old-${n}`,
      url: `https://catalog-videos-dev.test/v/${n}.mp4`
    })),
    markerValue: 'pub-1',
    previousMarker: 'seed',
    ...overrides
  });

  it('writes each product its own link through the recipe and verifies it', async () => {
    const store = bucket();
    seed(store);
    expect(await verifyFeedPublicationCells(store.r2, frozen(), signal)).toEqual({
      outcome: 'absent'
    });
    await applyFeedPublicationCells(store.r2, frozen(), signal);
    const rows = parseCatalogFeedCsv(new TextDecoder().decode(store.objects.get(KEY)!.bytes));
    expect(rows.slice(2).map(row => row[VIDEO_COLUMN])).toEqual(
      [1, 2, 3].map(n => `https://catalog-videos-dev.test/v/${n}.mp4`)
    );
    expect(rows.slice(2).map(row => row[ID_COLUMN])).toEqual(['old-1', 'old-2', 'old-3']);
    expect(await verifyFeedPublicationCells(store.r2, frozen(), signal)).toMatchObject({
      outcome: 'verified'
    });
  });

  it('a feed carrying another receipt is never written over', async () => {
    const store = bucket();
    seed(store, 'someone-else');
    await expect(applyFeedPublicationCells(store.r2, frozen(), signal)).rejects.toMatchObject({
      code: 'PROCESS_RESULT_UNCERTAIN'
    });
    expect(await verifyFeedPublicationCells(store.r2, frozen(), signal)).toEqual({
      outcome: 'unknown'
    });
  });

  it('a product set that changed is SOURCE_CHANGED', async () => {
    const store = bucket();
    seed(store);
    const products = [{ id: 'other', url: 'https://x.test/v.mp4' }, ...frozen().products.slice(1)];
    await expect(
      applyFeedPublicationCells(store.r2, frozen({ products }), signal)
    ).rejects.toBeInstanceOf(TeamFunctionError);
    expect(await verifyFeedPublicationCells(store.r2, frozen({ products }), signal)).toEqual({
      outcome: 'unknown',
      reason: 'SOURCE_CHANGED'
    });
  });
});
