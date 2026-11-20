/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_IMAGE_COLUMN,
  catalogNonVideoCellUpdates,
  catalogPreservedColumnIndices,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater.js';
import { PRODUCT_CATALOG_TEMPLATE } from '../supabase/functions/_shared/product-catalog.js';
import {
  parseClaimedCatalog,
  runCatalogUpdaterTick
} from '../supabase/functions/catalog-updater/worker.js';

/**
 * 062 (R20, R30, T024/T025/T053): the updater rebuilds a sheet from its snapshot and the
 * completion replaces the snapshot as a whole, so the creatives must travel through every round;
 * a catalog of several creatives or of images is only written by the targeted writer, which
 * keeps the video cells and, for images, H.
 */

const ID = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.key === 'id');
const TITLE = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.key === 'title');
const M = (n: number) => `62000000-0000-4000-8000-00000000030${n}`;

const layout = (kind: 'video' | 'image', rows: number[]) => ({
  _catalogCreativeKind: kind,
  _catalogCreatives: [
    { ordinal: 0, materialId: M(1), alias: 'IN40', kind },
    { ordinal: 1, materialId: M(2), alias: 'IN41', kind }
  ],
  _catalogRowCreatives: rows
});

const claimed = (snapshot: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  catalog_material_id: 'catalog',
  team_id: 'team',
  attempts: 1,
  update_count: 0,
  product_count: 3,
  source_link: 'https://offer.example.test/?sub=1',
  video_link: 'https://drive.google.com/file/d/A/view?usp=sharing',
  settings_snapshot: {
    title: 'Polo',
    description: 'Knit',
    price: 10,
    imageLink: 'https://img.example.test/white.png',
    ...snapshot
  },
  drive_file_id: 'sheet',
  resource_key: null,
  credential_id: 'cred',
  refresh_images: false,
  ...overrides
});

function setup(rows: unknown[], options: { legacy?: boolean; imageCells?: string[] } = {}) {
  const claims = [...rows.map(row => [row])];
  const written: unknown[][][] = [];
  const became: Record<string, unknown>[] = [];
  const retried: string[] = [];
  const videoCells = [
    'https://z.example.test/a1',
    'https://z.example.test/a2',
    'https://z.example.test/b1'
  ];
  const deps = {
    workerId: 'worker',
    ...(options.legacy
      ? {}
      : {
          authorizeLegacyVideoWrite: vi.fn(async () => false),
          prepareNonVideoUpdate: vi.fn(async item => ({
            contextToken: 'a'.repeat(64),
            productCount: item.productCount,
            videoCells,
            ...(options.imageCells ? { imageCells: options.imageCells } : {}),
            write: vi.fn(async builtRows => {
              written.push(builtRows);
            }),
            verify: vi.fn(async () => undefined)
          }))
        }),
    drawTexts: vi.fn(async (_team, count) =>
      Array.from({ length: count }, (_, index) => ({
        title: `Fresh Hoodie ${index}`,
        description: `Soft hoodie ${index}`
      }))
    ),
    openRounds: vi.fn(async () => 0),
    claim: vi.fn(async () => claims.shift() ?? []),
    driveFor: vi.fn(async () => ({
      getFile: vi.fn(async () => ({
        id: 'sheet',
        version: '1',
        trashed: false,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: {}
      }))
    })),
    progress: vi.fn(async () => true),
    beginWrite: vi.fn(async () => true),
    finishWrite: vi.fn(async () => true),
    recordChanges: vi.fn(async () => true),
    complete: vi.fn(async (_id, _count, _swapped, next) => {
      became.push(next.snapshot);
      return true;
    }),
    retry: vi.fn(async (_id, code) => {
      retried.push(code);
      return true;
    }),
    unknown: vi.fn(async () => true),
    markNeedsReauth: vi.fn(async () => undefined),
    claimRetired: vi.fn(async () => []),
    authorizeCleanup: vi.fn(async () => true),
    forgetCopy: vi.fn(async () => true),
    now: () => 0,
    log: vi.fn()
  };
  return { deps, written, became, retried, videoCells };
}

const ids = (rows: unknown[][]) => rows.slice(2).map(row => String(row[ID].v));
const column = (rows: unknown[][], index: number) => rows.slice(2).map(row => String(row[index].v));

describe('several videos through the updater', () => {
  it('keeps prefixes, kind and blocks over two updates in a row', async () => {
    const first = setup([claimed(layout('video', [0, 0, 1]))]);
    await runCatalogUpdaterTick(first.deps, { budgetMs: 1000 });
    expect(first.written).toHaveLength(1);
    expect(ids(first.written[0]).map(id => id.split('-')[0])).toEqual(['IN40', 'IN40', 'IN41']);
    // The video cells are the stored ones, never one link over every row.
    expect(column(first.written[0], catalogVideoColumnIndices()[0])).toEqual(first.videoCells);
    const snapshot = first.became[0];
    expect(snapshot._catalogCreativeKind).toBe('video');
    expect(snapshot._catalogRowCreatives).toEqual([0, 0, 1]);
    expect(snapshot._catalogCreatives).toHaveLength(2);

    const second = setup([claimed(snapshot, { update_count: 1 })]);
    await runCatalogUpdaterTick(second.deps, { budgetMs: 1000 });
    expect(ids(second.written[0]).map(id => id.split('-')[0])).toEqual(['IN40', 'IN40', 'IN41']);
    expect(ids(second.written[0]).some(id => ids(first.written[0]).includes(id))).toBe(false);
    expect(second.became[0]._catalogRowCreatives).toEqual([0, 0, 1]);
    expect(second.became[0]._catalogCreatives).toEqual(snapshot._catalogCreatives);
  });

  it('never takes the one-link legacy write', async () => {
    const run = setup([claimed(layout('video', [0, 0, 1]))], { legacy: true });
    const summary = await runCatalogUpdaterTick(run.deps, { budgetMs: 1000 });
    expect(summary.failed).toBe(1);
    expect(run.retried).toEqual(['MULTI_CREATIVE_UNSUPPORTED']);
    expect(run.deps.beginWrite).not.toHaveBeenCalled();
  });

  it('ignores growth and image refresh stored on the profile', () => {
    const item = parseClaimedCatalog(
      claimed(layout('video', [0, 0, 1]), { grow_products: true, refresh_images: true })
    );
    expect(item.growProducts).toBe(false);
    expect(item.refreshImages).toBe(false);
  });
});

describe('images through the updater', () => {
  const imageCells = [
    'https://images.example.test/c1/one.jpg',
    'https://images.example.test/c1/one.jpg',
    'https://images.example.test/c1/two.jpg'
  ];

  it('reads a catalog without a video link', () => {
    const item = parseClaimedCatalog(claimed(layout('image', [0, 0, 1]), { video_link: null }));
    expect(item).not.toBeNull();
    expect(item.creatives.kind).toBe('image');
  });

  it('leaves H as published while the texts change, update after update', async () => {
    const first = setup([claimed(layout('image', [0, 0, 1]), { video_link: null })], {
      imageCells
    });
    await runCatalogUpdaterTick(first.deps, { budgetMs: 1000 });
    expect(first.written).toHaveLength(1);
    expect(column(first.written[0], CATALOG_IMAGE_COLUMN)).toEqual(imageCells);
    expect(column(first.written[0], TITLE)[0]).toMatch(/^Fresh Hoodie/u);
    const second = setup([claimed(first.became[0], { video_link: null, update_count: 1 })], {
      imageCells
    });
    await runCatalogUpdaterTick(second.deps, { budgetMs: 1000 });
    expect(column(second.written[0], CATALOG_IMAGE_COLUMN)).toEqual(imageCells);
    expect(second.became[0]._catalogCreativeKind).toBe('image');
    expect(ids(second.written[0]).map(id => id.split('-')[0])).toEqual(['IN40', 'IN40', 'IN41']);
  });

  it('refuses a writer that did not read H back', async () => {
    const run = setup([claimed(layout('image', [0, 0, 1]), { video_link: null })]);
    await runCatalogUpdaterTick(run.deps, { budgetMs: 1000 });
    expect(run.written).toHaveLength(0);
    expect(run.retried).toEqual(['PROCESS_RESULT_UNCERTAIN']);
  });

  it('keeps H out of the targeted writer’s cells', () => {
    expect(catalogPreservedColumnIndices('image')).toContain(CATALOG_IMAGE_COLUMN);
    expect(catalogPreservedColumnIndices('video')).not.toContain(CATALOG_IMAGE_COLUMN);
    const rows = Array.from({ length: 3 }, () =>
      PRODUCT_CATALOG_TEMPLATE.map(() => ({ t: 'string', v: 'x' }))
    );
    const written = catalogNonVideoCellUpdates(rows, 0, 'image').map(update => update.columnIndex);
    expect(written).not.toContain(CATALOG_IMAGE_COLUMN);
    expect(catalogNonVideoCellUpdates(rows, 0).map(update => update.columnIndex)).toContain(
      CATALOG_IMAGE_COLUMN
    );
  });
});

describe('a catalog from before 062', () => {
  it('keeps its bare IDs and gains no layout', async () => {
    const run = setup([claimed({})]);
    await runCatalogUpdaterTick(run.deps, { budgetMs: 1000 });
    expect(ids(run.written[0]).every(id => /^[0-9A-Z]+-[0-9A-Z]{7}$/u.test(id))).toBe(true);
    expect(run.became[0]._catalogCreatives).toBeUndefined();
  });
});
