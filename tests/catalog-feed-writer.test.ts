import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_FEED_CONTENT_TYPE,
  catalogFeedCsv,
  catalogFeedKey,
  catalogFeedText,
  newCatalogFeedId,
  parseCatalogFeedCsv,
  writeCatalogFeed
} from '../supabase/functions/_shared/catalog-feed';
import {
  buildProductCatalogRows,
  PRODUCT_CATALOG_TEMPLATE
} from '../supabase/functions/_shared/product-catalog';
import {
  CatalogVideoR2,
  type CatalogVideoR2Config
} from '../supabase/functions/_shared/r2-catalog-video';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

/**
 * 057 T036: the catalog feed of an R2 space. It is the sheet, written as a CSV file under one
 * stable address: the same rows `buildProductCatalogRows` gives the Google sheet, the Meta
 * template's description row first, RFC 4180 quoting, `text/csv; charset=utf-8`.
 */

const FEED = 'f'.repeat(32);
const rows = () =>
  buildProductCatalogRows({
    settings: {
      title: 'Polo, "classic"',
      description: 'Knit\nline two',
      imageLink: 'https://catalog-images.soty.pp.ua/i/a.jpg',
      price: 12
    },
    sourceLink: 'https://offer.example.test/?sub=1&x=2',
    videoLink: 'https://catalog-videos.soty.pp.ua/v/' + 'a'.repeat(32) + '.mp4',
    count: 3,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })()
  });

/** A reference RFC 4180 writer, independent of the module, over what the sheet would hold. */
function reference(cells: ReturnType<typeof rows>): string {
  return cells
    .map(row =>
      row
        .map(cell => {
          const text = String(cell.v);
          return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(',')
    )
    .join('\r\n');
}

describe('catalog feed CSV', () => {
  it('is the sheet byte for byte: template header rows first, then the rows', () => {
    const built = rows();
    const text = catalogFeedText(built);
    expect(text).toBe(reference(built));
    const parsed = parseCatalogFeedCsv(text);
    expect(parsed[0]).toEqual(PRODUCT_CATALOG_TEMPLATE.map(column => column.description));
    expect(parsed[1]).toEqual(PRODUCT_CATALOG_TEMPLATE.map(column => column.key));
    expect(parsed).toHaveLength(5);
    expect(parsed.slice(2).map(row => row.length)).toEqual([
      PRODUCT_CATALOG_TEMPLATE.length,
      PRODUCT_CATALOG_TEMPLATE.length,
      PRODUCT_CATALOG_TEMPLATE.length
    ]);
    expect(parsed.slice(2).map(row => row[0])).toEqual(['id-1', 'id-2', 'id-3']);
    // Every cell reads back as the value the sheet would have held.
    built.forEach((row, r) => row.forEach((cell, c) => expect(parsed[r]![c]).toBe(String(cell.v))));
  });

  it('quotes by RFC 4180, has no BOM, and encodes as UTF-8', () => {
    const bytes = catalogFeedCsv([
      [
        { t: 'string', v: 'a,b' },
        { t: 'string', v: 'say "hi"' },
        { t: 'string', v: 'two\r\nlines' },
        { t: 'string', v: 'Київ' },
        { t: 'number', v: 75 },
        { t: 'string', v: '' }
      ]
    ]);
    expect(bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(bytes)).toBe('"a,b","say ""hi""","two\r\nlines",Київ,75,');
  });

  it('drops what the sheet could never hold, as the XLSX writer does', () => {
    expect(catalogFeedText([[{ t: 'string', v: 'a\u0000b\u000bc\ud800d' }]])).toBe('abc�d');
    expect(
      catalogFeedText([
        [
          { t: 'decimal', v: '12.00' },
          { t: 'decimal', v: '1.50' }
        ]
      ])
    ).toBe('12,1.50');
  });

  it('gives each catalog an unguessable stable key', () => {
    const id = newCatalogFeedId();
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(newCatalogFeedId()).not.toBe(id);
    expect(catalogFeedKey(FEED)).toBe(`feeds/${FEED}.csv`);
    expect(() => catalogFeedKey('../x')).toThrow(TeamFunctionError);
  });
});

// The public bucket and the CDN, faked through the real adapter.
const config: CatalogVideoR2Config = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'soty-catalog-videos-dev-staging',
  publicBucket: 'soty-catalog-videos-dev-public',
  publicOrigin: 'https://catalog-videos-dev.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'not-a-real-token',
  partVerification: 'readback'
};
const signer = {
  async sign(request: Request) {
    const headers = new Headers(request.headers);
    headers.set('authorization', 'AWS4-HMAC-SHA256 signed');
    return new Request(request, { headers });
  }
};

function bucket(options: { failPut?: boolean; purgeOk?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  const calls: string[] = [];
  const purged: string[][] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.host === 'api.cloudflare.com') {
      expect(request.headers.get('authorization')).toBe('Bearer not-a-real-token');
      purged.push(((await request.json()) as { files: string[] }).files);
      return new Response(JSON.stringify({ success: options.purgeOk !== false }), {
        status: options.purgeOk === false ? 500 : 200
      });
    }
    const [, name, ...rest] = url.pathname.split('/');
    expect(name).toBe('soty-catalog-videos-dev-public');
    const key = rest.join('/');
    if (request.method === 'PUT') {
      if (options.failPut) return new Response('<Error/>', { status: 503 });
      objects.set(key, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        headers: new Headers(request.headers)
      });
      return new Response(null, { status: 200, headers: { etag: `"e${objects.size}"` } });
    }
    if (request.method === 'GET') {
      const held = objects.get(key);
      if (!held) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(held.bytes), {
        status: 200,
        headers: {
          etag: '"held"',
          'x-amz-meta-soty-feed-attempt': held.headers.get('x-amz-meta-soty-feed-attempt') ?? ''
        }
      });
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return { r2: new CatalogVideoR2(config, signer, fetcher), objects, calls, purged };
}

describe('writeCatalogFeed', () => {
  const signal = new AbortController().signal;

  it('writes text/csv to feeds/{feed_id}.csv in the public bucket and purges that address', async () => {
    const store = bucket();
    const built = rows();
    const written = await writeCatalogFeed(
      store.r2,
      { feedId: FEED, rows: built, marker: 'm-1' },
      signal
    );
    const held = store.objects.get(`feeds/${FEED}.csv`)!;
    expect(new TextDecoder().decode(held.bytes)).toBe(reference(built));
    expect(held.headers.get('content-type')).toBe(CATALOG_FEED_CONTENT_TYPE);
    expect(CATALOG_FEED_CONTENT_TYPE).toBe('text/csv; charset=utf-8');
    expect(held.headers.get('x-amz-meta-soty-feed-attempt')).toBe('m-1');
    expect(written).toMatchObject({
      feedId: FEED,
      url: `https://catalog-videos-dev.test/feeds/${FEED}.csv`,
      bytes: held.bytes.byteLength,
      purged: true
    });
    expect(store.purged).toEqual([[`https://catalog-videos-dev.test/feeds/${FEED}.csv`]]);
  });

  it('rewrites the same key on every update, so the address Meta reads stays the same', async () => {
    const store = bucket();
    const first = await writeCatalogFeed(
      store.r2,
      { feedId: FEED, rows: rows(), marker: 'a' },
      signal
    );
    const again = await writeCatalogFeed(
      store.r2,
      { feedId: FEED, rows: rows().slice(0, 3), marker: 'b' },
      signal
    );
    expect(again.url).toBe(first.url);
    expect([...store.objects.keys()]).toEqual([`feeds/${FEED}.csv`]);
    expect(
      parseCatalogFeedCsv(new TextDecoder().decode(store.objects.get(`feeds/${FEED}.csv`)!.bytes))
    ).toHaveLength(3);
    expect(store.purged).toHaveLength(2);
  });

  it('a failed write leaves the previous feed in place and purges nothing', async () => {
    const store = bucket();
    await writeCatalogFeed(store.r2, { feedId: FEED, rows: rows(), marker: 'a' }, signal);
    const before = store.objects.get(`feeds/${FEED}.csv`)!.bytes;
    const failing = bucket({ failPut: true });
    failing.objects.set(`feeds/${FEED}.csv`, { bytes: before, headers: new Headers() });
    await expect(
      writeCatalogFeed(failing.r2, { feedId: FEED, rows: rows().slice(0, 2), marker: 'b' }, signal)
    ).rejects.toMatchObject({ code: 'VIDEO_R2_PROVIDER_UNAVAILABLE', retryable: true });
    expect(failing.objects.get(`feeds/${FEED}.csv`)!.bytes).toBe(before);
    expect(failing.purged).toEqual([]);
    expect(failing.calls.some(call => call.startsWith('DELETE'))).toBe(false);
  });

  it('a purge that fails does not undo a written feed: the short TTL rule bounds it', async () => {
    const store = bucket({ purgeOk: false });
    const log = vi.fn();
    const written = await writeCatalogFeed(
      store.r2,
      { feedId: FEED, rows: rows(), marker: 'a' },
      signal,
      log
    );
    expect(written.purged).toBe(false);
    expect(store.objects.has(`feeds/${FEED}.csv`)).toBe(true);
    expect(log).toHaveBeenCalledWith('[catalog-feed] purge failed', FEED);
  });

  it('reads back its own feed with the marker it carries; removes it with a purge', async () => {
    const store = bucket();
    await writeCatalogFeed(store.r2, { feedId: FEED, rows: rows(), marker: 'm-7' }, signal);
    const read = await store.r2.readFeed(catalogFeedKey(FEED), signal);
    expect(read?.marker).toBe('m-7');
    expect(parseCatalogFeedCsv(new TextDecoder().decode(read!.bytes))).toHaveLength(5);
    await store.r2.removeFeed(catalogFeedKey(FEED), signal);
    expect(store.objects.size).toBe(0);
    expect(await store.r2.readFeed(catalogFeedKey(FEED), signal)).toBeNull();
    expect(store.purged.at(-1)).toEqual([`https://catalog-videos-dev.test/feeds/${FEED}.csv`]);
  });
});

// The seam (T037): the Google sheet is still what every Drive space gets, call for call; an R2
// space hands in the feed writer and its address becomes the catalog's `sheet_url`.
import {
  createProductCatalog,
  type CatalogDrive,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';
import { createCatalogFeedDocumentWriter } from '../supabase/functions/drive-ops/catalog-feed-document';

const TEAM = '57000000-0000-4000-8000-000000000001';
const VIDEO = '57000000-0000-4000-8000-000000000002';
const SHEET = '57000000-0000-4000-8000-000000000003';
const ACTOR = '57000000-0000-4000-8000-000000000004';
const OPERATION = '57000000-0000-4000-8000-000000000005';

function live(overrides: Record<string, unknown> = {}) {
  return {
    id: 'drive-video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    parents: ['folder'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: { canDownload: true, canShare: true, canModifyContent: true },
    size: 10,
    modifiedAt: null,
    version: '1',
    checksum: null,
    webViewLink: null,
    thumbnailLink: null,
    appProperties: {},
    ...overrides
  };
}

function creation(options: { link?: unknown; failLink?: boolean } = {}) {
  const calls: string[] = [];
  const shared = new Set(['drive-video']);
  const drive = {
    listAnyonePermissions: vi.fn(async (id: string) => {
      calls.push(`listAnyone ${id}`);
      return shared.has(id) ? [{ id: 'p', role: 'reader' }] : [];
    }),
    createAnyoneReaderPermission: vi.fn(async (id: string) => {
      calls.push(`share ${id}`);
      shared.add(id);
      return { id: 'new', role: 'reader' };
    }),
    createConvertedFile: vi.fn(async (input: { name: string }) => {
      calls.push(`createConvertedFile ${input.name}`);
      return live({
        id: 'drive-sheet',
        name: input.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/drive-sheet/edit',
        size: 4096
      });
    }),
    updateFileMetadata: vi.fn(async (input: { fileId: string }) => {
      calls.push(`trash ${input.fileId}`);
      return live();
    })
  };
  const deps = {
    loadVideo: vi.fn(async () => ({
      id: VIDEO,
      name: 'clip.mp4',
      category: 'video',
      driveFileId: 'drive-video',
      resourceKey: null,
      parentFolderId: 'folder',
      credentialId: 'cred'
    })),
    resolveRestitchedVideo: vi.fn(),
    readSettings: vi.fn(async () => ({
      title: 'Polo',
      description: 'Knit',
      imageLink: 'https://img.example.test/a.png',
      priceMin: 10,
      priceMax: 10
    })),
    drawTexts: vi.fn(async () => []),
    drawImages: vi.fn(async () => []),
    readLiveCatalogs: vi.fn(async () => []),
    nextVariant: vi.fn(async () => 1),
    driveFor: vi.fn(async () => drive as unknown as CatalogDrive),
    proveVideo: vi.fn(async () => live()),
    destination: vi.fn(async () => ({
      materialId: null,
      live: live({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
    })),
    planName: vi.fn(async ({ name }: { name: string }) => ({ name, reservationKey: name })),
    startOperation: vi.fn(async () => ({
      operationId: OPERATION,
      state: 'pending' as const,
      reused: false
    })),
    bindIntent: vi.fn(async () => {
      calls.push('bindIntent');
    }),
    markRunning: vi.fn(async () => undefined),
    failOperation: vi.fn(async () => {
      calls.push('failOperation');
    }),
    finalize: vi.fn(async () => {
      calls.push('finalize');
      return { materialId: SHEET };
    }),
    link: vi.fn(async () => {
      calls.push('link');
      if (options.failLink) throw new TeamFunctionError('INVALID_RESPONSE');
      return options.link ?? { linked: true, retired: [] };
    }),
    log: vi.fn()
  } as unknown as ProductCatalogDeps;
  return { deps, drive, calls };
}

const request = {
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 3,
  replacesMaterialId: null,
  idempotencyKey: 'catalog:0057-attempt'
};

describe('CatalogDocumentWriter seam', () => {
  it('a Drive space still gets the Google sheet, call for call', async () => {
    const f = creation();
    const result = await createProductCatalog(f.deps, request, ACTOR);
    expect(f.calls).toEqual([
      'listAnyone drive-video',
      'createConvertedFile clip_v1_catalog',
      'bindIntent',
      'listAnyone drive-sheet',
      'share drive-sheet',
      'listAnyone drive-sheet',
      'finalize',
      'link'
    ]);
    expect(result.catalog.sheetUrl).toBe('https://docs.google.com/spreadsheets/d/drive-sheet/edit');
    const record = vi.mocked(f.deps.link).mock.calls[0]![0].record;
    expect(Object.keys(record)).toEqual([
      'sourceLink',
      'productCount',
      'sheetUrl',
      'videoLink',
      'settingsSnapshot',
      'createdBy',
      'variant'
    ]);
  });

  it('a Google sheet that loses the race is trashed twice, as before', async () => {
    const f = creation({ link: { linked: false, reason: 'NOT_ELIGIBLE' } });
    await expect(createProductCatalog(f.deps, request, ACTOR)).rejects.toMatchObject({
      code: 'WRONG_STATE'
    });
    expect(f.calls.slice(-4)).toEqual([
      'link',
      'trash drive-sheet',
      'trash drive-sheet',
      'failOperation'
    ]);
  });

  function feedCreation(options: { failCommit?: boolean; failLink?: boolean } = {}) {
    const f = creation({ failLink: options.failLink });
    const store = bucket();
    const commit = vi.fn(async (input: { feedId: string; bytes: number; name: string }) => {
      f.calls.push(`commit ${input.feedId}`);
      if (options.failCommit) throw new TeamFunctionError('WRONG_STATE');
      return { materialId: SHEET };
    });
    f.deps.documentWriter = createCatalogFeedDocumentWriter({
      store: store.r2,
      signal: new AbortController().signal,
      newFeedId: () => FEED,
      commit,
      log: vi.fn()
    });
    return { ...f, store, commit };
  }

  it('an R2 space writes its feed and keeps the feed address as sheet_url', async () => {
    const f = feedCreation();
    const result = await createProductCatalog(f.deps, request, ACTOR);
    expect(f.drive.createConvertedFile).not.toHaveBeenCalled();
    expect(f.deps.bindIntent).not.toHaveBeenCalled();
    expect(f.deps.finalize).not.toHaveBeenCalled();
    const url = `https://catalog-videos-dev.test/feeds/${FEED}.csv`;
    expect(result.catalog).toMatchObject({ materialId: SHEET, sheetUrl: url });
    const held = f.store.objects.get(`feeds/${FEED}.csv`)!;
    expect(held.headers.get('x-amz-meta-soty-feed-attempt')).toBe(OPERATION);
    const csv = parseCatalogFeedCsv(new TextDecoder().decode(held.bytes));
    expect(csv[1]).toEqual(PRODUCT_CATALOG_TEMPLATE.map(column => column.key));
    expect(csv).toHaveLength(5);
    expect(f.commit).toHaveBeenCalledWith({
      operationId: OPERATION,
      actorId: ACTOR,
      name: 'clip_v1_catalog',
      feedId: FEED,
      feedUrl: url,
      bytes: held.bytes.byteLength
    });
    const record = vi.mocked(f.deps.link).mock.calls[0]![0].record;
    expect(record).toMatchObject({ sheetUrl: url, feedId: FEED, feedBytes: held.bytes.byteLength });
  });

  it('a failed commit or link removes the feed it wrote', async () => {
    for (const failure of [{ failCommit: true }, { failLink: true }]) {
      const f = feedCreation(failure);
      await expect(createProductCatalog(f.deps, request, ACTOR)).rejects.toBeInstanceOf(
        TeamFunctionError
      );
      expect(f.store.objects.size).toBe(0);
      expect(f.calls.at(-1)).toBe('failOperation');
    }
  });
});
