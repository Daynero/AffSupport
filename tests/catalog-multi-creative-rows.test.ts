/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive.js';
import {
  PRODUCT_CATALOG_TEMPLATE,
  buildProductCatalogRows,
  catalogRowCreatives,
  parseCatalogCreativeLayout,
  productCatalogName
} from '../supabase/functions/_shared/product-catalog.js';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';

/**
 * 062 (contracts/catalog-rows.md): a catalog of several creatives is one sheet of contiguous
 * blocks. Each block's products carry their creative's prefix and link their creative's own
 * video; an image block shows its creative in H and has no video and no tag.
 */

const column = (key: string) => PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.key === key);
const ID = column('id');
const H = column('image_link');
const Z = column('video[0].url');
const AA = column('video[0].tag[0]');
const cells = (rows: { v: string | number }[][], index: number) =>
  rows.slice(2).map(row => String(row[index]!.v));

const settings = {
  title: 'Polo',
  description: 'Knit',
  price: 10,
  imageLink: 'https://img.example.test/white.png'
};
const PREFIXED = (prefix: string) => new RegExp(`^${prefix}-[0-9A-Z]+-[0-9A-Z]{7}$`, 'u');

describe('buildProductCatalogRows with creatives', () => {
  it('writes the blocks in creative order with each one’s prefix and video', () => {
    const rows = buildProductCatalogRows({
      settings,
      sourceLink: 'https://offer.example.test/',
      videoLink: 'https://drive.google.com/file/d/A/view?usp=sharing',
      count: 6,
      creatives: [
        { idPrefix: 'A1', kind: 'video' },
        {
          idPrefix: 'B2',
          kind: 'video',
          videoLink: 'https://drive.google.com/file/d/B/view?usp=sharing'
        },
        {
          idPrefix: 'C3',
          kind: 'video',
          videoLink: 'https://drive.google.com/file/d/C/view?usp=sharing'
        }
      ],
      rowCreatives: catalogRowCreatives([3, 2, 1])
    });
    const ids = cells(rows, ID);
    expect(ids.slice(0, 3).every(id => PREFIXED('A1').test(id))).toBe(true);
    expect(ids.slice(3, 5).every(id => PREFIXED('B2').test(id))).toBe(true);
    expect(PREFIXED('C3').test(ids[5]!)).toBe(true);
    const videos = cells(rows, Z);
    expect(videos.slice(0, 3).every(link => link.includes('/d/A/') && /[?&]v=/u.test(link))).toBe(
      true
    );
    expect(videos.slice(3, 5).every(link => link.includes('/d/B/'))).toBe(true);
    expect(videos[5]).toContain('/d/C/');
    expect(new Set(videos).size).toBe(6);
  });

  it('shows an image creative in H, with no video and no tag', () => {
    const rows = buildProductCatalogRows({
      settings,
      sourceLink: 'https://offer.example.test/',
      videoLink: '',
      count: 3,
      creatives: [
        { idPrefix: 'img1', kind: 'image', imageLink: 'https://images.example.test/c1/one.jpg' },
        { idPrefix: 'img2', kind: 'image', imageLink: 'https://images.example.test/c1/two.jpg' }
      ],
      rowCreatives: [0, 0, 1]
    });
    expect(cells(rows, H)).toEqual([
      'https://images.example.test/c1/one.jpg',
      'https://images.example.test/c1/one.jpg',
      'https://images.example.test/c1/two.jpg'
    ]);
    expect(cells(rows, Z)).toEqual(['', '', '']);
    expect(cells(rows, AA)).toEqual(['', '', '']);
  });

  it('keeps the white picture in H while the image’s publication is held', () => {
    const rows = buildProductCatalogRows({
      settings,
      sourceLink: 'https://offer.example.test/',
      videoLink: '',
      count: 2,
      creatives: [{ idPrefix: 'img', kind: 'image' }],
      rowCreatives: [0, 0]
    });
    expect(cells(rows, H)).toEqual([settings.imageLink, settings.imageLink]);
  });

  it('refuses a row map that does not cover every row', () => {
    expect(() =>
      buildProductCatalogRows({
        settings,
        sourceLink: 'https://offer.example.test/',
        videoLink: 'https://drive.google.com/file/d/A/view',
        count: 3,
        creatives: [{ idPrefix: 'A', kind: 'video' }],
        rowCreatives: [0, 0]
      })
    ).toThrow('INVALID_INPUT');
  });
});

describe('the snapshot layout', () => {
  const creative = (ordinal: number) => ({
    ordinal,
    materialId: `62000000-0000-4000-8000-00000000000${ordinal}`,
    alias: `c${ordinal}`,
    kind: 'video'
  });
  it('is absent on a catalog from before 062', () => {
    expect(parseCatalogCreativeLayout({ title: 'x' })).toBeNull();
  });
  it('reads contiguous blocks and refuses gaps or a wrong count', () => {
    const snapshot = {
      _catalogCreativeKind: 'video',
      _catalogCreatives: [creative(0), creative(1)],
      _catalogRowCreatives: [0, 0, 1]
    };
    expect(parseCatalogCreativeLayout(snapshot, 3)?.rowCreatives).toEqual([0, 0, 1]);
    expect(() => parseCatalogCreativeLayout(snapshot, 4)).toThrow();
    expect(() =>
      parseCatalogCreativeLayout({ ...snapshot, _catalogRowCreatives: [0, 1, 0] }, 3)
    ).toThrow();
    expect(() =>
      parseCatalogCreativeLayout({ ...snapshot, _catalogRowCreatives: [0, 0, 0] }, 3)
    ).toThrow();
  });
});

describe('the catalog name', () => {
  it('names the first creative and counts the others (same rule as SQL)', () => {
    expect(productCatalogName('IN 40.mp4', 2)).toBe('IN 40_v2_catalog');
    expect(productCatalogName('IN 40.mp4', 1, 3)).toBe('IN 40+3_v1_catalog');
    expect(productCatalogName('photo.jpg', 4, 1)).toBe('photo+1_v4_catalog');
  });
});

// ── createProductCatalog end to end, Drive and database faked ─────────────────────────────

const TEAM = '62000000-0000-4000-8000-0000000000aa';
const ACTOR = '62000000-0000-4000-8000-0000000000bb';
const SHEET = '62000000-0000-4000-8000-0000000000cc';
const M = (n: number) => `62000000-0000-4000-8000-00000000010${n}`;

function metadata(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: 'drive-file',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    parents: ['folder'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canShare: true,
      canTrash: true,
      canUntrash: true
    },
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

function setup(
  options: {
    kind?: 'video' | 'image';
    categories?: Record<string, string>;
    images?: (ordinal: number) => { link: string; linkKind: 'r2' | 'drive'; imageId?: string };
  } = {}
) {
  const kind = options.kind ?? 'video';
  const ext = kind === 'image' ? 'jpg' : 'mp4';
  const mime = kind === 'image' ? 'image/jpeg' : 'video/mp4';
  const shared = new Set<string>();
  const drive = {
    listAnyonePermissions: vi.fn(async (fileId: string) =>
      shared.has(fileId) ? [{ id: 'p', role: 'reader' }] : []
    ),
    createAnyoneReaderPermission: vi.fn(async (fileId: string) => {
      shared.add(fileId);
      return { id: 'p', role: 'reader' as const };
    }),
    createConvertedFile: vi.fn(async (input: { name: string }) =>
      metadata({
        id: 'sheet',
        name: input.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/sheet/edit'
      })
    ),
    updateFileMetadata: vi.fn(async () => metadata())
  };
  const captured: { rows?: unknown[][] } = {};
  const deps: ProductCatalogDeps = {
    loadVideo: vi.fn(async ({ videoId }) => ({
      id: videoId,
      name: `creative-${videoId.slice(-1)}.${ext}`,
      category: options.categories?.[videoId] ?? kind,
      driveFileId: `drive-${videoId.slice(-1)}`,
      resourceKey: null,
      parentFolderId: 'folder',
      credentialId: 'cred'
    })),
    resolveRestitchedVideo: vi.fn(),
    readSettings: vi.fn(async () => ({ ...settings, priceMin: 10, priceMax: 10 })),
    drawTexts: vi.fn(async () => []),
    drawImages: vi.fn(async () => []),
    readLiveCatalogs: vi.fn(async () => []),
    nextVariant: vi.fn(async () => 1),
    driveFor: vi.fn(async () => drive),
    proveVideo: vi.fn(async video =>
      metadata({ id: video.driveFileId, name: video.name, mimeType: mime })
    ),
    destination: vi.fn(async () => ({
      materialId: null,
      live: metadata({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
    })),
    planName: vi.fn(async ({ name }) => ({ name, reservationKey: name })),
    startOperation: vi.fn(async () => ({ operationId: 'op', state: 'pending', reused: false })),
    bindIntent: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    failOperation: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ materialId: SHEET })),
    link: vi.fn(async () => ({ linked: true as const, retired: [] })),
    rememberSheetRows: vi.fn(async rows => {
      captured.rows = rows;
      return rows;
    }),
    ...(kind === 'image'
      ? {
          publishCreativeImages: vi.fn(async ({ images }) =>
            images.map(image => ({
              ordinal: image.ordinal,
              ...(options.images?.(image.ordinal) ?? {
                link: `https://images.example.test/c1/${image.ordinal}.jpg`,
                linkKind: 'r2' as const,
                imageId: `62000000-0000-4000-8000-00000000020${image.ordinal}`
              })
            }))
          )
        }
      : {}),
    log: vi.fn()
  };
  return { deps, drive, captured };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: M(1),
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 7,
  replacesMaterialId: null,
  restitchOperationId: null,
  idempotencyKey: 'launch:62000000-0000-4000-8000-000000000999:catalog',
  catalogVideoProtocolVersion: 1,
  restitchEnabled: false,
  videoVariationCount: 1,
  videoPublication: { mode: 'immediate' },
  creativeKind: 'video',
  creatives: [
    { materialId: M(1), alias: 'IN40', copies: 3 },
    { materialId: M(2), alias: 'IN41', copies: 2 },
    { materialId: M(3), alias: 'IN42', copies: 1 },
    { materialId: M(4), alias: 'IN43', copies: 1 }
  ],
  ...overrides
});

describe('createProductCatalog with several videos', () => {
  it('shares every video and gives each block its own original', async () => {
    const { deps, drive, captured } = setup();
    const result = await createProductCatalog(deps, request(), ACTOR);
    expect(result.outcome).toBe('created');
    expect(result.catalog.name).toBe('creative-1+3_v1_catalog');
    // Every video is opened to anyone with the link, then the sheet.
    expect(drive.createAnyoneReaderPermission.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining(['drive-1', 'drive-2', 'drive-3', 'drive-4', 'sheet'])
    );
    const rows = captured.rows!;
    const ids = cells(rows, ID);
    expect(ids.slice(0, 3).every(id => PREFIXED('IN40').test(id))).toBe(true);
    expect(ids.slice(3, 5).every(id => PREFIXED('IN41').test(id))).toBe(true);
    expect(PREFIXED('IN42').test(ids[5]!)).toBe(true);
    expect(PREFIXED('IN43').test(ids[6]!)).toBe(true);
    const videos = cells(rows, Z);
    expect(videos.slice(0, 3).every(link => link.includes('/d/drive-1/'))).toBe(true);
    expect(videos.slice(3, 5).every(link => link.includes('/d/drive-2/'))).toBe(true);
    expect(videos[5]).toContain('/d/drive-3/');
    expect(videos[6]).toContain('/d/drive-4/');
    const record = deps.link.mock.calls[0][0].record;
    expect(record.videoLink).toContain('/d/drive-1/');
    expect(record.settingsSnapshot._catalogCreativeKind).toBe('video');
    expect(record.settingsSnapshot._catalogRowCreatives).toEqual([0, 0, 0, 1, 1, 2, 3]);
    expect(record.settingsSnapshot._catalogCreatives.map(c => c.alias)).toEqual([
      'IN40',
      'IN41',
      'IN42',
      'IN43'
    ]);
  });

  it('links each block with its own SUB «Креатив» and keeps it for later updates (owner, 2026-11-21)', async () => {
    const { deps, captured } = setup();
    const blockLinks = ['IN40', 'IN41', 'IN42', 'IN43'].map(
      alias => `https://offer.example.test/?sub3=${alias}`
    );
    deps.resolveCreativeSourceLinks = vi.fn(async () => blockLinks);
    await createProductCatalog(deps, request(), ACTOR);
    const LINK = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'sourceLink');
    expect(cells(captured.rows!, LINK)).toEqual([
      blockLinks[0],
      blockLinks[0],
      blockLinks[0],
      blockLinks[1],
      blockLinks[1],
      blockLinks[2],
      blockLinks[3]
    ]);
    const record = deps.link.mock.calls[0][0].record;
    expect(record.settingsSnapshot._catalogCreatives.map(c => c.sourceLink)).toEqual(blockLinks);
  });

  it('refuses block links that do not match the creatives', async () => {
    const { deps } = setup();
    deps.resolveCreativeSourceLinks = vi.fn(async () => ['https://offer.example.test/?sub3=IN40']);
    await expect(createProductCatalog(deps, request(), ACTOR)).rejects.toMatchObject({
      code: 'LAUNCH_SUB_INVALID'
    });
  });

  it('refuses a mixed set before anything is written', async () => {
    const { deps, drive } = setup({ categories: { [M(3)]: 'image' } });
    await expect(createProductCatalog(deps, request(), ACTOR)).rejects.toMatchObject({
      code: 'CREATIVES_MIXED'
    });
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
    expect(drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
  });

  it('keeps the share exact: blocks follow the copies', async () => {
    const { deps, captured } = setup();
    await createProductCatalog(
      deps,
      request({
        productCount: 10,
        creatives: [
          { materialId: M(1), alias: 'a', copies: 4 },
          { materialId: M(2), alias: 'b', copies: 3 },
          { materialId: M(3), alias: 'c', copies: 2 },
          { materialId: M(4), alias: 'd', copies: 1 }
        ]
      }),
      ACTOR
    );
    const prefixes = cells(captured.rows!, ID).map(id => id.split('-')[0]);
    expect(prefixes).toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'd']);
  });

  it('gives a single explorer video a prefix from its name', async () => {
    const { deps, captured } = setup();
    await createProductCatalog(
      deps,
      {
        teamId: TEAM,
        videoMaterialId: M(1),
        sourceLink: 'https://offer.example.test/',
        productCount: 2,
        replacesMaterialId: null,
        idempotencyKey: 'catalog:0001-attempt'
      },
      ACTOR
    );
    expect(cells(captured.rows!, ID).every(id => PREFIXED('creative-1').test(id))).toBe(true);
    const snapshot = deps.link.mock.calls[0][0].record.settingsSnapshot;
    expect(snapshot._catalogCreatives).toEqual([
      expect.objectContaining({ ordinal: 0, materialId: M(1), alias: 'creative-1', kind: 'video' })
    ]);
  });
});

describe('createProductCatalog with images', () => {
  const images = (overrides: Record<string, unknown> = {}) =>
    request({
      productCount: 3,
      creativeKind: 'image',
      creatives: [
        { materialId: M(1), alias: 'pic1', copies: 2 },
        { materialId: M(2), alias: 'pic2', copies: 1 }
      ],
      ...overrides
    });

  it('writes white texts and the creative in H, with no video, tag or video link', async () => {
    const { deps, drive, captured } = setup({ kind: 'image' });
    await createProductCatalog(deps, images({ copyVideoToR2: true }), ACTOR);
    // The white pool is drawn exactly as for a white catalog.
    expect(deps.drawImages).toHaveBeenCalledWith(TEAM, 3, expect.anything());
    const rows = captured.rows!;
    expect(cells(rows, H)).toEqual([
      'https://images.example.test/c1/0.jpg',
      'https://images.example.test/c1/0.jpg',
      'https://images.example.test/c1/1.jpg'
    ]);
    expect(cells(rows, Z)).toEqual(['', '', '']);
    expect(cells(rows, AA)).toEqual(['', '', '']);
    expect(cells(rows, column('title'))).toEqual(['Polo', 'Polo', 'Polo']);
    // With R2 the images themselves are never opened to anyone: their copy is published.
    expect(drive.createAnyoneReaderPermission.mock.calls.map(call => call[0])).toEqual(['sheet']);
    expect(deps.publishCreativeImages).toHaveBeenCalledWith(
      expect.objectContaining({ copyToR2: true })
    );
    const record = deps.link.mock.calls[0][0].record;
    expect(record.videoLink).toBeNull();
    expect(record.settingsSnapshot._catalogCreativeKind).toBe('image');
    expect(record.settingsSnapshot._catalogCreatives[1]).toMatchObject({
      link: 'https://images.example.test/c1/1.jpg',
      linkKind: 'r2',
      imageId: '62000000-0000-4000-8000-000000000201'
    });
    expect(record.settingsSnapshot.rows.every(row => row.videoTag === '')).toBe(true);
  });

  it('opens Drive images to anyone with the link when R2 is off', async () => {
    const { deps, drive } = setup({
      kind: 'image',
      images: ordinal => ({
        link: `https://drive.google.com/uc?export=view&id=drive-${ordinal + 1}`,
        linkKind: 'drive'
      })
    });
    await createProductCatalog(deps, images(), ACTOR);
    expect(drive.createAnyoneReaderPermission.mock.calls.map(call => call[0])).toEqual([
      'drive-1',
      'drive-2',
      'sheet'
    ]);
    expect(deps.loadVideo).toHaveBeenCalledWith(expect.objectContaining({ permission: 'edit' }));
    const snapshot = deps.link.mock.calls[0][0].record.settingsSnapshot;
    expect(snapshot._catalogCreatives[0]).toMatchObject({ linkKind: 'drive' });
    expect(snapshot._catalogCreatives[0].imageId).toBeUndefined();
  });

  it('keeps white pictures in H until a scheduled publication', async () => {
    const { deps, captured } = setup({ kind: 'image' });
    await createProductCatalog(
      deps,
      images({
        videoPublication: {
          mode: 'scheduled',
          localDateTime: '2026-12-01T10:00',
          timeZone: 'Europe/Kyiv',
          resolvedOffset: '+02:00',
          dueAt: '2026-12-01T08:00:00.000Z'
        }
      }),
      ACTOR
    );
    expect(cells(captured.rows!, H)).toEqual([
      settings.imageLink,
      settings.imageLink,
      settings.imageLink
    ]);
    const snapshot = deps.link.mock.calls[0][0].record.settingsSnapshot;
    expect(snapshot._catalogCreatives[0].link).toBeUndefined();
    expect(snapshot._catalogCreatives[0].imageId).toBe('62000000-0000-4000-8000-000000000200');
  });

  it('refuses restitch for images and several creatives off the video protocol', () => {
    expect(() =>
      parseCreateProductCatalogRequest(images({ restitchEnabled: true, videoVariationCount: 1 }))
    ).toThrow(TeamFunctionError);
    const legacy = request();
    delete legacy.catalogVideoProtocolVersion;
    delete legacy.restitchEnabled;
    delete legacy.videoVariationCount;
    delete legacy.videoPublication;
    expect(() => parseCreateProductCatalogRequest(legacy)).toThrow('MULTI_CREATIVE_UNSUPPORTED');
  });

  it('refuses shares that do not add up and duplicates', () => {
    expect(() => parseCreateProductCatalogRequest(request({ productCount: 8 }))).toThrow(
      'DISTRIBUTION_INVALID'
    );
    expect(() =>
      parseCreateProductCatalogRequest(
        request({
          productCount: 2,
          creatives: [
            { materialId: M(1), alias: 'a', copies: 1 },
            { materialId: M(1), alias: 'b', copies: 1 }
          ]
        })
      )
    ).toThrow('CREATIVE_DUPLICATE');
  });
});
