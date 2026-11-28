import { describe, expect, it, vi } from 'vitest';
import {
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../supabase/functions/_shared/catalog-feed';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { catalogFeedIdFor } from '../supabase/functions/drive-ops/catalog-feed-document';
import {
  assertSpaceCatalogRequest,
  noDriveForSpace,
  spaceCatalogDeps,
  spaceCatalogRequest
} from '../supabase/functions/drive-ops/catalog-space-source';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';

/**
 * 057 T040/T041: a catalog created in an R2 space. The generator is the Drive one; under it the
 * space's seam reads the video and its folder from the space, links the video from its R2 copy
 * (planned under the object's content id), writes the feed under an id derived from the
 * operation, commits the feed as the operation's result and links it — and never reaches Drive.
 */

const TEAM = '05743000-0000-4000-8000-000000000001';
const VIDEO = '05743000-0000-4000-8000-000000000002';
const FOLDER = '05743000-0000-4000-8000-000000000003';
const FEED_ROW = '05743000-0000-4000-8000-000000000004';
const ACTOR = '05743000-0000-4000-8000-000000000005';
const OPERATION = '05743000-0000-4000-8000-000000000006';
const COPY = '05743000-0000-4000-8000-000000000007';
const CONTENT = 'c'.repeat(64);
const ORIGIN = 'https://catalog-videos-beta.soty.pp.ua';
const VIDEO_URL = `${ORIGIN}/v/${'a'.repeat(32)}.mp4`;

const request = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 3,
  replacesMaterialId: null,
  idempotencyKey: 'product-catalog:0001-attempt',
  ...overrides
});

const videoRow = (overrides: Record<string, unknown> = {}) => ({
  id: VIDEO,
  name: 'clip.mp4',
  kind: 'file',
  category: 'video',
  mimeType: 'video/mp4',
  parentFolderId: FOLDER,
  sizeBytes: '5000',
  contentId: CONTENT,
  ...overrides
});
const folderRow = {
  id: FOLDER,
  name: 'Shop',
  kind: 'folder',
  category: null,
  mimeType: null,
  parentFolderId: null,
  sizeBytes: null,
  contentId: null
};

function store() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const feeds: CatalogFeedStore = {
    feedUrl: key => `${ORIGIN}/${key}`,
    putFeed: vi.fn(async (key: string, bytes: Uint8Array) => {
      calls.push(`put ${key}`);
      objects.set(key, bytes);
      return { etag: '"e"' };
    }),
    readFeed: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, etag: '"e"', marker: OPERATION } : null;
    }),
    removeFeed: vi.fn(async (key: string) => {
      calls.push(`remove ${key}`);
      objects.delete(key);
    }),
    purgeUrls: vi.fn(async () => true)
  };
  return { feeds, objects, calls };
}

function setup(options: { link?: Record<string, unknown> } = {}) {
  const bucket = store();
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
    rpcCalls.push([name, parameters]);
    switch (name) {
      case 'service_space_catalog_material':
        return parameters.p_material === FOLDER ? folderRow : videoRow();
      case 'service_space_catalog_video_link':
        return { url: VIDEO_URL, copyId: COPY, state: 'planned', sourceVersion: CONTENT };
      case 'service_catalog_video_r2_kick':
        return null;
      case 'service_space_catalog_names':
        return [];
      case 'service_commit_space_catalog_feed':
        return { materialId: FEED_ROW, reused: false };
      case 'service_link_space_catalog_feed':
        return options.link ?? { linked: true, retired: [], variant: 1 };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  const space = spaceCatalogDeps({
    rpc,
    feeds: bucket.feeds,
    signal: new AbortController().signal,
    log: vi.fn()
  });
  const deps: ProductCatalogDeps = {
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
    ...space
  } as ProductCatalogDeps;
  return { deps, rpc, rpcCalls, bucket };
}

describe('a catalog of an R2 space', () => {
  it('is made from the space: the feed, its companion and the R2 copy link, never Drive', async () => {
    const f = setup();
    const result = await createProductCatalog(f.deps, request(), ACTOR);
    const feedId = await catalogFeedIdFor(OPERATION);
    const key = `feeds/${feedId}.csv`;
    expect(result).toMatchObject({
      outcome: 'created',
      videoShared: false,
      catalog: { materialId: FEED_ROW, sheetUrl: `${ORIGIN}/${key}`, productCount: 3 }
    });
    // The feed's rows link the video's R2 copy (with each row's variation), not a Drive file.
    const csv = parseCatalogFeedCsv(new TextDecoder().decode(f.bucket.objects.get(key)!));
    expect(csv).toHaveLength(5);
    for (const row of csv.slice(2)) {
      expect(row.some(cell => cell.startsWith(VIDEO_URL))).toBe(true);
      expect(row.some(cell => cell.includes('drive.google.com'))).toBe(false);
    }
    expect(f.rpcCalls.map(([name]) => name)).toEqual([
      'service_space_catalog_material',
      'service_space_catalog_material',
      'service_space_catalog_material',
      'service_space_catalog_video_link',
      'service_catalog_video_r2_kick',
      'service_space_catalog_names',
      'service_commit_space_catalog_feed',
      'service_link_space_catalog_feed'
    ]);
    expect(f.rpcCalls[2]![1]).toMatchObject({ p_material: FOLDER, p_permission: 'upload' });
    const bytes = f.bucket.objects.get(key)!.byteLength;
    expect(f.rpcCalls[6]![1]).toEqual({
      p_operation: OPERATION,
      p_actor: ACTOR,
      p_name: 'clip_v1_catalog',
      p_bytes: bytes
    });
    const linked = f.rpcCalls[7]![1];
    expect(linked).toMatchObject({
      p_team: TEAM,
      p_video: VIDEO,
      p_companion: FEED_ROW,
      p_actor: ACTOR
    });
    expect(linked.p_record).toMatchObject({
      sheetUrl: `${ORIGIN}/${key}`,
      videoLink: VIDEO_URL,
      feedId,
      feedBytes: bytes
    });
    expect(f.deps.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ destinationMaterialId: FOLDER, videoId: VIDEO })
    );
  });

  it('writes a resumed creation over the same feed: its id follows the operation', async () => {
    const first = await catalogFeedIdFor(OPERATION);
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(await catalogFeedIdFor(OPERATION)).toBe(first);
    expect(first).not.toBe(OPERATION.replaceAll('-', ''));
    expect(await catalogFeedIdFor(COPY)).not.toBe(first);
  });

  it('removes the feed of a catalog that lost the race', async () => {
    const f = setup({
      link: {
        linked: false,
        reason: 'EXISTS',
        existing: {
          id: FEED_ROW,
          name: 'clip_v1_catalog',
          sheetUrl: `${ORIGIN}/feeds/${'b'.repeat(32)}.csv`,
          sourceLink: 'https://offer.example.test/?sub=0',
          productCount: 3,
          variant: 1,
          createdAt: null
        }
      }
    });
    f.deps.preserveUncertainOutput = true;
    const result = await createProductCatalog(f.deps, request(), ACTOR);
    expect(result.outcome).toBe('existing');
    expect(f.bucket.calls.at(-1)).toBe(`remove feeds/${await catalogFeedIdFor(OPERATION)}.csv`);
  });

  it('refuses a video R2 cannot serve before anything is made', async () => {
    const f = setup();
    f.rpc.mockImplementation(async (name: string, parameters: Record<string, unknown>) => {
      if (name === 'service_space_catalog_video_link')
        throw new TeamFunctionError('VIDEO_R2_UNSUPPORTED_FORMAT', { retryable: false });
      if (name === 'service_space_catalog_material')
        return parameters.p_material === FOLDER
          ? folderRow
          : videoRow({ name: 'clip.mp4', mimeType: 'video/mp4' });
      return null;
    });
    await expect(createProductCatalog(f.deps, request(), ACTOR)).rejects.toMatchObject({
      code: 'VIDEO_R2_UNSUPPORTED_FORMAT'
    });
    expect(f.deps.startOperation).not.toHaveBeenCalled();
    expect(f.bucket.feeds.putFeed).not.toHaveBeenCalled();
  });

  it('refuses what has no R2 path yet, before anything is read', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ restitchOperationId: COPY }, 'STORAGE_BACKEND_MISMATCH'],
      [
        {
          creativeKind: 'video',
          creatives: [
            { materialId: VIDEO, alias: 'a', copies: 2 },
            { materialId: COPY, alias: 'b', copies: 1 }
          ],
          // T104: several creatives published at once are made; re-stitched ones are not yet.
          catalogVideoProtocolVersion: 1,
          restitchEnabled: true,
          videoVariationCount: 2,
          videoPublication: { mode: 'immediate' }
        },
        'MULTI_CREATIVE_UNSUPPORTED'
      ]
    ];
    for (const [overrides, code] of cases) {
      const f = setup();
      await expect(createProductCatalog(f.deps, request(overrides), ACTOR)).rejects.toMatchObject({
        code
      });
      expect(() =>
        assertSpaceCatalogRequest(
          spaceCatalogRequest(parseCreateProductCatalogRequest(request(overrides)))
        )
      ).toThrow(TeamFunctionError);
      expect(f.rpc).not.toHaveBeenCalled();
    }
  });

  it('carries out the dialog protocol without re-stitched videos as the plain request', () => {
    const parsed = parseCreateProductCatalogRequest(
      request({
        catalogVideoProtocolVersion: 1,
        restitchEnabled: false,
        videoVariationCount: 1,
        videoPublication: { mode: 'immediate' },
        copyVideoToR2: true
      })
    );
    const plain = spaceCatalogRequest(parsed);
    expect(plain).toEqual(parseCreateProductCatalogRequest(request()));
    expect(() => assertSpaceCatalogRequest(plain)).not.toThrow();
    const scheduled = parseCreateProductCatalogRequest(
      request({
        catalogVideoProtocolVersion: 1,
        restitchEnabled: false,
        videoVariationCount: 1,
        videoPublication: {
          mode: 'scheduled',
          localDateTime: '2026-12-01T10:00',
          timeZone: 'Europe/Kyiv',
          resolvedOffset: '+02:00',
          dueAt: '2026-12-01T08:00:00.000Z'
        }
      })
    );
    // T102: a link published later keeps the protocol; its video authority answers for it.
    expect(spaceCatalogRequest(scheduled)).toEqual(scheduled);
    expect(() => assertSpaceCatalogRequest(scheduled)).not.toThrow();
  });

  it('refuses the protocol without the videos its authority proved, before anything is read', async () => {
    const f = setup();
    await expect(
      createProductCatalog(
        f.deps,
        request({
          catalogVideoProtocolVersion: 1,
          restitchEnabled: true,
          videoVariationCount: 2,
          videoPublication: {
            mode: 'scheduled',
            localDateTime: '2026-12-01T10:00',
            timeZone: 'Europe/Kyiv',
            resolvedOffset: '+02:00',
            dueAt: '2026-12-01T08:00:00.000Z'
          }
        }),
        ACTOR
      )
    ).rejects.toMatchObject({ code: 'STORAGE_BACKEND_MISMATCH' });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('gives the generator a Drive client that refuses every call', async () => {
    const drive = noDriveForSpace();
    await expect(drive.listAnyonePermissions('x')).rejects.toMatchObject({
      code: 'STORAGE_BACKEND_MISMATCH'
    });
    await expect(drive.getFile('x')).rejects.toMatchObject({ code: 'STORAGE_BACKEND_MISMATCH' });
  });
});
