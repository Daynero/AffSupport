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
import { prepareCatalogClaims } from '../supabase/functions/catalog-updater/claim-preparation.js';
import { globalImageFixture } from './fixtures/catalog-global.js';

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

describe('an updater restitch round over several videos', () => {
  const id = (n: number) => 'c6200000-0000-4000-8000-' + String(n).padStart(12, '0');
  const seed = (n: number) => String(n).repeat(64).slice(0, 64);
  const settings = {
    configured: true,
    operation: 'restitch',
    sourceMode: 'legacy',
    startImageIds: [id(90)],
    endImageIds: [],
    fitMode: 'cover',
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 60,
    updatedAt: '',
    updatedBy: null
  };
  const segment = (ordinal: number, rows: number[], requests: number[]) => ({
    ordinal,
    set_id: id(10 + ordinal),
    source_material_id: id(20 + ordinal),
    recipe_row_ids: rows.map(id),
    child_request_ids: requests.map(id),
    assignment_seed: seed(ordinal + 1),
    requested_count: requests.length,
    provider_context: { fileId: 'f', connectionId: id(5), credentialId: id(6), rootFolderId: 'r' }
  });
  const accepted = (segments: unknown[]) => ({
    request_id: id(4),
    team_id: id(1),
    actor_id: id(2),
    catalog_material_id: id(3),
    set_id: id(10),
    attempt_id: id(7),
    executor_id: id(8),
    source_material_id: id(20),
    requested_count: 3,
    recipe_row_ids: [id(100), id(101), id(102), id(103)],
    child_request_ids: [id(200), id(201), id(202)],
    provider_context: { fileId: 'f', connectionId: id(5), credentialId: id(6), rootFolderId: 'r' },
    settings_snapshot: settings,
    assignment_seed: seed(9),
    canceled_at: null,
    segments
  });

  it('hands the variations out round-robin and checks each set’s share', async () => {
    const { parseCatalogUpdaterVariantSegments } =
      await import('../supabase/functions/drive-ops/updater-variants.js');
    const ok = [segment(0, [100, 101], [200, 201]), segment(1, [102, 103], [202])];
    expect(parseCatalogUpdaterVariantSegments(accepted(ok), 3).map(s => s.requestedCount)).toEqual([
      2, 1
    ]);
    // 2 · 1 is the only split of 3 over two blocks of two; 1 · 2 is refused.
    const swapped = [segment(0, [100, 101], [200]), segment(1, [102, 103], [201, 202])];
    expect(() => parseCatalogUpdaterVariantSegments(accepted(swapped), 3)).toThrow(
      'INVALID_RESPONSE'
    );
    expect(
      parseCatalogUpdaterVariantSegments({ ...accepted(ok), segments: undefined }, 3)
    ).toBeNull();
  });

  it('admits one set per video with its own rows, seed and source', async () => {
    const { materializeCatalogUpdaterVariantRequest } =
      await import('../supabase/functions/drive-ops/updater-variants.js');
    const { catalogVideoSettingsDigest } =
      await import('../supabase/functions/drive-ops/catalog-video-set-admission.js');
    const { createCatalogVideoAssignment } =
      await import('../packages/shared/src/team/catalog-video-set.js');
    // The round's frozen settings are digested as stored.
    const digest = await catalogVideoSettingsDigest(settings);
    const segments = [segment(0, [100, 101], [200, 201]), segment(1, [102, 103], [202])];
    const asked: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_read_catalog_video_acceptance') {
        asked.push(args.p_set as string);
        const s = segments.find(x => x.set_id === args.p_set)!;
        return {
          error: null,
          data: {
            settingsDigest: digest,
            catalogIntentId: null,
            updateAttemptId: id(7),
            source: { materialId: s.source_material_id, teamId: id(1), actorId: id(2) },
            snapshot: {
              setId: s.set_id,
              children: s.child_request_ids.map((requestId, index) => ({ index, requestId }))
            },
            parentState: 'preparing',
            assignment: createCatalogVideoAssignment({
              recipeRevision: 1,
              recipeRowIds: s.recipe_row_ids,
              variantCount: s.requested_count,
              seed: s.assignment_seed
            })
          }
        };
      }
      return { error: null, data: null };
    });
    await materializeCatalogUpdaterVariantRequest(
      { rpc },
      {
        teamId: id(1),
        actorId: id(2),
        catalogMaterialId: id(3),
        requestId: id(4),
        requestedCount: 3
      },
      accepted(segments),
      vi.fn()
    );
    expect(asked).toEqual([id(10), id(11)]);
    expect(rpc.mock.calls.map(([name]) => name)).toContain(
      'service_note_catalog_updater_variant_admission'
    );
  });
});

describe('an image catalog in the global white pool, round after round (R30)', () => {
  const imageCells = [
    'https://images.example.test/c1/one.jpg',
    'https://images.example.test/c1/one.jpg',
    'https://images.example.test/c1/two.jpg'
  ];
  /** The claim goes through the real preparation, which forces refresh_images in global mode. */
  async function round(snapshot: Record<string, unknown>, updateCount: number, firstImage: number) {
    const calls: string[] = [];
    const [prepared] = (
      await prepareCatalogClaims(
        [claimed(snapshot, { video_link: null, update_count: updateCount })],
        'worker',
        async name => {
          calls.push(name);
          return name === 'service_catalog_image_mode_v2'
            ? 'global'
            : '62000000-0000-4000-8000-0000000009aa';
        }
      )
    ).rows;
    expect(prepared).toMatchObject({ refresh_images: true, global_images: true });
    const run = setup([prepared], { imageCells });
    const drawn: string[] = [];
    run.deps.drawTexts = vi.fn(async (_team, count) =>
      Array.from({ length: count }, (_, index) => ({
        title: `Round ${updateCount} Black Hoodie ${index}`,
        description: `A black hoodie, round ${updateCount}`
      }))
    );
    run.deps.drawImages = vi.fn(async (_team, count) =>
      Array.from({ length: count }, (_, index) => {
        const image = globalImageFixture(firstImage + index);
        drawn.push(image.publicUrl);
        return image;
      })
    );
    await runCatalogUpdaterTick(run.deps, { budgetMs: 1000 });
    expect(run.written).toHaveLength(1);
    return { run, drawn };
  }

  it('redraws the whites for the texts and never touches H', async () => {
    const first = await round(layout('image', [0, 0, 1]), 0, 1);
    const firstRows = first.run.became[0].rows;
    // The whites behind the texts are the freshly drawn ones…
    expect(firstRows.map(row => row.imageLink)).toEqual(first.drawn);
    // …while H shows the creatives as the publication lane left them.
    expect(column(first.run.written[0], CATALOG_IMAGE_COLUMN)).toEqual(imageCells);
    const second = await round(first.run.became[0], 1, 10);
    const secondRows = second.run.became[0].rows;
    expect(secondRows.map(row => row.imageLink)).toEqual(second.drawn);
    expect(secondRows.map(row => row.imageLink)).not.toEqual(firstRows.map(row => row.imageLink));
    expect(column(second.run.written[0], CATALOG_IMAGE_COLUMN)).toEqual(imageCells);
    // Texts moved on, the creative layout stayed.
    expect(column(second.run.written[0], TITLE)).not.toEqual(column(first.run.written[0], TITLE));
    expect(second.run.became[0]._catalogCreativeKind).toBe('image');
    expect(second.run.became[0]._catalogRowCreatives).toEqual([0, 0, 1]);
    // No image row carries a video tag.
    const AA = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.key === 'video[0].tag[0]');
    expect(column(second.run.written[0], AA)).toEqual(['', '', '']);
  });
});

describe('attaching a ready round of several videos', () => {
  const uuid = (n: number) => 'c6200000-0000-4000-8000-' + String(n).padStart(12, '0');
  const segment = (ordinal: number, set: number | null, kind = 'video') => ({
    ordinal,
    kind,
    materialId: uuid(30 + ordinal),
    ...(set === null ? {} : { videoSetId: uuid(set), recipeRevision: 1 }),
    rowStart: ordinal * 2,
    rowCount: 2
  });
  it('accepts a new creatives revision whose video blocks name their own sets', async () => {
    const { isAttachedVariantTarget } =
      await import('../supabase/functions/drive-ops/updater-variants.js');
    expect(
      isAttachedVariantTarget({ kind: 'video_set', videoSetId: uuid(1), recipeRevision: 1 })
    ).toBe(true);
    expect(
      isAttachedVariantTarget({ kind: 'creatives', segments: [segment(0, 1), segment(1, 2)] })
    ).toBe(true);
  });
  it('refuses a revision with one set, a shared set or a block of another kind', async () => {
    const { isAttachedVariantTarget } =
      await import('../supabase/functions/drive-ops/updater-variants.js');
    expect(isAttachedVariantTarget({ kind: 'creatives', segments: [segment(0, 1)] })).toBe(false);
    expect(
      isAttachedVariantTarget({ kind: 'creatives', segments: [segment(0, 1), segment(1, 1)] })
    ).toBe(false);
    expect(
      isAttachedVariantTarget({
        kind: 'creatives',
        segments: [segment(0, 1), segment(1, 2, 'image')]
      })
    ).toBe(false);
    expect(
      isAttachedVariantTarget({
        kind: 'creatives',
        segments: [segment(0, 1), { ...segment(1, 2), recipeRevision: 2 }]
      })
    ).toBe(false);
    expect(isAttachedVariantTarget({ kind: 'source', materialId: uuid(1) })).toBe(false);
  });
});
