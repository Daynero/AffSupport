import { describe, expect, it, vi } from 'vitest';
import {
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../supabase/functions/_shared/catalog-feed';
import {
  CATALOG_IMAGE_COLUMN,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater';
import { catalogFeedIdFor } from '../supabase/functions/drive-ops/catalog-feed-document';
import {
  assertSpaceCatalogRequest,
  spaceCatalogDeps,
  spaceCatalogRequest
} from '../supabase/functions/drive-ops/catalog-space-source';
import { spaceCreativeImageSource } from '../supabase/functions/drive-ops/catalog-space-creative-images';
import { createCreativeImagePublisher } from '../supabase/functions/drive-ops/creative-images';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';

/**
 * 057 T103/T104: a Launch's catalog in an R2 space — several videos, or pictures. The request
 * keeps the protocol 062 accepts them on; each video is linked from its own R2 copy, each picture
 * is published from the space bucket into the public image bucket (`c1/`), and nothing reaches
 * Drive. What still needs a set or a target per creative (re-stitching, a later link) is refused
 * before anything is read.
 */

const TEAM = '05791050-0000-4000-8000-000000000001';
const FIRST = '05791050-0000-4000-8000-000000000002';
const SECOND = '05791050-0000-4000-8000-000000000003';
const FOLDER = '05791050-0000-4000-8000-000000000004';
const FEED_ROW = '05791050-0000-4000-8000-000000000005';
const ACTOR = '05791050-0000-4000-8000-000000000006';
const OPERATION = '05791050-0000-4000-8000-000000000007';
const IMAGE_ID = '05791050-0000-4000-8000-000000000008';
const ORIGIN = 'https://catalog-videos-beta.soty.pp.ua';
const url = (material: string) => `${ORIGIN}/v/${material.slice(-1).repeat(32)}.mp4`;
const content = (material: string) => material.slice(-1).repeat(64);

const creatives = [
  { materialId: FIRST, alias: 'first', copies: 2 },
  { materialId: SECOND, alias: 'second', copies: 1 }
];
const request = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: FIRST,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 3,
  replacesMaterialId: null,
  idempotencyKey: 'launch:05791050-0000-4000-8000-0000000000aa:catalog',
  catalogVideoProtocolVersion: 1,
  restitchEnabled: false,
  videoVariationCount: 1,
  videoPublication: { mode: 'immediate' },
  creativeKind: 'video',
  creatives,
  ...overrides
});

const file = (id: string, kind: 'video' | 'image') => ({
  id,
  name: kind === 'video' ? `${id.slice(-1)}.mp4` : `${id.slice(-1)}.png`,
  kind: 'file',
  category: kind,
  mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  parentFolderId: FOLDER,
  sizeBytes: '5000',
  contentId: content(id)
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

function setup(kind: 'video' | 'image' = 'video') {
  const objects = new Map<string, Uint8Array>();
  const feeds: CatalogFeedStore = {
    feedUrl: key => `${ORIGIN}/${key}`,
    putFeed: vi.fn(async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
      return { etag: '"e"' };
    }),
    readFeed: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, etag: '"e"', marker: OPERATION } : null;
    }),
    removeFeed: vi.fn(async () => undefined),
    purgeUrls: vi.fn(async () => true)
  };
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
    rpcCalls.push([name, parameters]);
    switch (name) {
      case 'service_space_catalog_material':
        return parameters.p_material === FOLDER
          ? folderRow
          : file(String(parameters.p_material), kind);
      case 'service_space_catalog_video_link':
        return {
          url: url(String(parameters.p_material)),
          copyId: IMAGE_ID,
          state: 'ready',
          sourceVersion: content(String(parameters.p_material))
        };
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
  const publishCreativeImages = vi.fn<NonNullable<ProductCatalogDeps['publishCreativeImages']>>(
    async ({ images }) =>
      images.map(image => ({
        ordinal: image.ordinal,
        link: `https://catalog-images.soty.pp.ua/c1/${image.material.id}`,
        linkKind: 'r2' as const,
        imageId: IMAGE_ID
      }))
  );
  const space = spaceCatalogDeps({
    rpc,
    feeds,
    signal: new AbortController().signal,
    log: vi.fn(),
    publishCreativeImages
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
    ...space
  } as ProductCatalogDeps;
  const feed = async () =>
    parseCatalogFeedCsv(
      new TextDecoder().decode(objects.get(`feeds/${await catalogFeedIdFor(OPERATION)}.csv`)!)
    ).slice(2);
  return { deps, rpc, rpcCalls, publishCreativeImages, feed };
}

const VIDEO_COLUMN = catalogVideoColumnIndices()[0]!;

describe('a Launch catalog of an R2 space', () => {
  it('links each video creative from its own R2 copy, block by block, never Drive', async () => {
    const f = setup();
    const parsed = parseCreateProductCatalogRequest(request({ copyVideoToR2: true }));
    // 062 accepts creatives only on the protocol: the space keeps it and drops the copy option.
    const carried = spaceCatalogRequest(parsed);
    expect(carried.catalogVideoProtocolVersion).toBe(1);
    expect(carried.copyVideoToR2).toBeUndefined();
    expect(() => assertSpaceCatalogRequest(carried)).not.toThrow();
    const result = await createProductCatalog(f.deps, carried, ACTOR);
    expect(result).toMatchObject({ outcome: 'created', videoShared: false });
    const rows = await f.feed();
    expect(rows.map(row => row[VIDEO_COLUMN]!.split('?')[0])).toEqual([
      url(FIRST),
      url(FIRST),
      url(SECOND)
    ]);
    expect(rows.flat().some(cell => cell.includes('drive.google.com'))).toBe(false);
    expect(
      f.rpcCalls
        .filter(([name]) => name === 'service_space_catalog_video_link')
        .map(([, parameters]) => parameters.p_material)
    ).toEqual([FIRST, SECOND]);
    const record = f.rpcCalls.find(([name]) => name === 'service_link_space_catalog_feed')![1]
      .p_record as Record<string, Record<string, unknown>>;
    expect(record.videoLink).toBe(url(FIRST));
    expect(record.settingsSnapshot!._catalogCreatives).toMatchObject([
      { materialId: FIRST, link: url(FIRST), linkKind: 'r2' },
      { materialId: SECOND, link: url(SECOND), linkKind: 'r2' }
    ]);
    expect(f.publishCreativeImages).not.toHaveBeenCalled();
  });

  it('publishes each picture creative to R2 and links no video', async () => {
    const f = setup('image');
    const result = await createProductCatalog(
      f.deps,
      parseCreateProductCatalogRequest(
        request({
          creativeKind: 'image',
          creatives: creatives.map(creative => ({ ...creative, materialId: creative.materialId }))
        })
      ),
      ACTOR
    );
    expect(result).toMatchObject({ outcome: 'created' });
    expect(f.publishCreativeImages).toHaveBeenCalledTimes(1);
    expect(f.publishCreativeImages.mock.calls[0]![0]).toMatchObject({ copyToR2: true });
    expect(f.publishCreativeImages.mock.calls[0]![0].images.map(image => image.ordinal)).toEqual([
      0, 1
    ]);
    const rows = await f.feed();
    expect(rows.map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    expect(rows.map(row => row[CATALOG_IMAGE_COLUMN])).toEqual([
      `https://catalog-images.soty.pp.ua/c1/${FIRST}`,
      `https://catalog-images.soty.pp.ua/c1/${FIRST}`,
      `https://catalog-images.soty.pp.ua/c1/${SECOND}`
    ]);
    expect(f.rpcCalls.some(([name]) => name === 'service_space_catalog_video_link')).toBe(false);
    const record = f.rpcCalls.find(([name]) => name === 'service_link_space_catalog_feed')![1]
      .p_record as Record<string, Record<string, unknown>>;
    expect(record.videoLink).toBeNull();
    expect(record.settingsSnapshot!._catalogCreatives).toMatchObject([
      { imageId: IMAGE_ID, linkKind: 'r2' },
      { imageId: IMAGE_ID, linkKind: 'r2' }
    ]);
  });

  it('makes a Launch’s frozen single-video request as it was accepted, copy option and all', async () => {
    const f = setup();
    const frozen = parseCreateProductCatalogRequest(
      request({ creativeKind: undefined, creatives: undefined, copyVideoToR2: true })
    );
    expect(frozen.catalogVideoProtocolVersion).toBe(1);
    await expect(createProductCatalog(f.deps, frozen, ACTOR)).resolves.toMatchObject({
      outcome: 'created'
    });
    expect((await f.feed()).map(row => row[VIDEO_COLUMN]!.split('?')[0])).toEqual([
      url(FIRST),
      url(FIRST),
      url(FIRST)
    ]);
  });

  it('names the creation’s key to the link of a video published later', async () => {
    const f = setup();
    const later = parseCreateProductCatalogRequest(
      request({
        creatives: [{ materialId: FIRST, alias: 'first', copies: 3 }],
        videoPublication: {
          mode: 'scheduled',
          localDateTime: '2026-12-01T10:00',
          timeZone: 'Europe/Kyiv',
          resolvedOffset: '+02:00',
          dueAt: '2026-12-01T08:00:00.000Z'
        }
      })
    );
    await createProductCatalog({ ...f.deps, videoDelivery: { kind: 'deferred' } }, later, ACTOR);
    expect((await f.feed()).map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    const linked = f.rpcCalls.find(([name]) => name === 'service_link_space_catalog_feed')![1];
    expect((linked.p_record as Record<string, unknown>).spacePublicationKey).toBe(
      'launch:05791050-0000-4000-8000-0000000000aa:catalog'
    );
  });

  it('makes several creatives or pictures published later with empty cells and the key (T117)', async () => {
    const scheduled = {
      mode: 'scheduled',
      localDateTime: '2026-12-01T10:00',
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '+02:00',
      dueAt: '2026-12-01T08:00:00.000Z'
    };
    const videos = setup();
    await createProductCatalog(
      { ...videos.deps, videoDelivery: { kind: 'deferred' } },
      parseCreateProductCatalogRequest(request({ videoPublication: scheduled })),
      ACTOR
    );
    expect((await videos.feed()).map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    const linked = videos.rpcCalls.find(([name]) => name === 'service_link_space_catalog_feed')![1]
      .p_record as Record<string, Record<string, unknown>>;
    expect(linked.spacePublicationKey).toBe('launch:05791050-0000-4000-8000-0000000000aa:catalog');
    // The creatives hold no link until the publication writes theirs.
    expect(linked.settingsSnapshot!._catalogCreatives).toEqual([
      expect.not.objectContaining({ link: expect.anything() }),
      expect.not.objectContaining({ link: expect.anything() })
    ]);
    // Each video's copy is still planned now, so the publication finds it ready when due.
    expect(
      videos.rpcCalls
        .filter(([name]) => name === 'service_space_catalog_video_link')
        .map(([, parameters]) => parameters.p_material)
    ).toEqual([FIRST, SECOND]);
    const pictures = setup('image');
    await createProductCatalog(
      { ...pictures.deps, videoDelivery: { kind: 'deferred' } },
      parseCreateProductCatalogRequest(
        request({ creativeKind: 'image', creatives, videoPublication: scheduled })
      ),
      ACTOR
    );
    const rows = await pictures.feed();
    // H waits for the publication: the creatives' pictures are published, not linked yet.
    expect(rows.map(row => row[CATALOG_IMAGE_COLUMN])).not.toContain(
      `https://catalog-images.soty.pp.ua/c1/${FIRST}`
    );
    expect(rows.map(row => row[VIDEO_COLUMN])).toEqual(['', '', '']);
    expect(pictures.publishCreativeImages).toHaveBeenCalledTimes(1);
    expect(
      (
        pictures.rpcCalls.find(([name]) => name === 'service_link_space_catalog_feed')![1]
          .p_record as Record<string, unknown>
      ).spacePublicationKey
    ).toBe('launch:05791050-0000-4000-8000-0000000000aa:catalog');
  });

  it('refuses several creatives that need a set or a target each, without the generator, before anything is read', async () => {
    const scheduled = {
      mode: 'scheduled',
      localDateTime: '2026-12-01T10:00',
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '+02:00',
      dueAt: '2026-12-01T08:00:00.000Z'
    };
    for (const overrides of [
      { restitchEnabled: true, videoVariationCount: 2 },
      { videoPublication: scheduled },
      {
        creativeKind: 'image',
        videoPublication: scheduled
      }
    ]) {
      const f = setup();
      const parsed = parseCreateProductCatalogRequest(request(overrides));
      expect(() => assertSpaceCatalogRequest(spaceCatalogRequest(parsed))).toThrow(
        expect.objectContaining({ code: 'MULTI_CREATIVE_UNSUPPORTED' })
      );
      await expect(createProductCatalog(f.deps, parsed, ACTOR)).rejects.toMatchObject({
        code: 'MULTI_CREATIVE_UNSUPPORTED'
      });
      expect(f.rpc).not.toHaveBeenCalled();
    }
  });
});

describe('a picture creative of an R2 space', () => {
  const live = {
    id: FIRST,
    name: 'cover.png',
    mimeType: 'image/png',
    version: content(FIRST),
    checksum: null,
    size: 5000,
    resourceKey: null
  };

  it('is reserved by its content id and read from the space bucket', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      calls.push([name, parameters]);
      if (name === 'service_reserve_space_creative_image')
        return { state: 'reserved', id: IMAGE_ID, objectKey: `c1/${IMAGE_ID}` };
      if (name === 'service_catalog_image_space_source')
        return { key: `t/${TEAM}/o/${content(FIRST)}`, size: 5000 };
      throw new Error(`unexpected rpc ${name}`);
    });
    const bytes = new Uint8Array(5000).fill(7);
    const space = {
      open: vi.fn(async () => ({
        size: 5000,
        etag: '"e"',
        contentType: 'image/png',
        body: new Response(bytes).body
      }))
    };
    const source = spaceCreativeImageSource({ rpc, space });
    const service = {
      rpc: vi.fn(async (name: string, parameters: Record<string, unknown>) => {
        calls.push([name, parameters]);
        return { data: { url: `https://catalog-images.test/c1/${IMAGE_ID}` }, error: null };
      })
    };
    const r2 = {
      putFinal: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      publicUrl: (key: string) => `https://catalog-images.test/${key}`
    };
    const publish = createCreativeImagePublisher({
      service: service as never,
      r2: r2 as never,
      ...source,
      optimize: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        image: { mime: 'image/png', sha256: 'a'.repeat(64) }
      })) as never,
      verifyAnonymous: vi.fn(async () => undefined) as never
    });
    const links = await publish({
      teamId: TEAM,
      actorId: ACTOR,
      copyToR2: true,
      images: [
        {
          ordinal: 0,
          material: { id: FIRST } as never,
          live: live as never,
          drive: {} as never
        }
      ]
    });
    expect(links).toEqual([
      {
        ordinal: 0,
        link: `https://catalog-images.test/c1/${IMAGE_ID}`,
        linkKind: 'r2',
        imageId: IMAGE_ID
      }
    ]);
    expect(calls[0]).toEqual([
      'service_reserve_space_creative_image',
      expect.objectContaining({
        p_team: TEAM,
        p_actor: ACTOR,
        p_material: FIRST,
        p_content: content(FIRST)
      })
    ]);
    expect(calls[1]).toEqual([
      'service_catalog_image_space_source',
      { p_team: TEAM, p_actor: ACTOR, p_material: FIRST, p_content: content(FIRST) }
    ]);
    expect(space.open).toHaveBeenCalledWith(
      `t/${TEAM}/o/${content(FIRST)}`,
      { method: 'GET' },
      expect.anything()
    );
    expect(r2.putFinal).toHaveBeenCalledWith(
      `c1/${IMAGE_ID}`,
      expect.any(Uint8Array),
      'image/png',
      expect.anything(),
      'a'.repeat(64)
    );
    expect(calls.map(([name]) => name)).not.toContain('service_reserve_launch_creative_image');
  });

  it('refuses a file whose bytes changed under it', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'service_reserve_space_creative_image')
        return { state: 'reserved', id: IMAGE_ID, objectKey: `c1/${IMAGE_ID}` };
      return { key: `t/${TEAM}/o/${'f'.repeat(64)}`, size: 5000 };
    });
    const source = spaceCreativeImageSource({ rpc, space: { open: vi.fn() } });
    await expect(
      source.readMaterial(
        TEAM,
        ACTOR,
        FIRST,
        { fileId: FIRST, resourceKey: null, version: content(FIRST), checksum: null, size: 5000 },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(
      source.reserve!({
        teamId: TEAM,
        actorId: ACTOR,
        material: { id: FIRST } as never,
        live: { ...live, version: 'drive-version' } as never,
        attempt: IMAGE_ID
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
});
