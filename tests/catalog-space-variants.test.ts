import { describe, expect, it, vi } from 'vitest';
import { createCatalogVideoAssignment } from '@video-compressor/shared';
import {
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../supabase/functions/_shared/catalog-feed';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  assertSpaceCatalogRequest,
  spaceCatalogDeps,
  spaceCatalogRequest,
  spaceCatalogVariations
} from '../supabase/functions/drive-ops/catalog-space-source';
import {
  cancelSpaceCatalogVariants,
  readSpaceCatalogVariants,
  spaceCatalogVideoAuthority,
  spaceVariantSettings,
  type SpaceVariantBinding
} from '../supabase/functions/drive-ops/catalog-space-variants';
import {
  createCatalogInitialVideoPlan,
  type CatalogInitialVideoPlan
} from '../supabase/functions/drive-ops/catalog-video-generation';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';

/**
 * 057 T095: a catalog with re-stitched variations in an R2 space. The durable generator and
 * its plan are the Drive ones; the space's video authority admits the variation set, reports its
 * progress, and once every variation has its output gives each row the R2 address of its
 * variation by the plan's seeded assignment. The catalog links the set, never a copy of the
 * original, and nothing reaches Drive.
 */

const TEAM = '05791000-0000-4000-8000-000000000001';
const VIDEO = '05791000-0000-4000-8000-000000000002';
const FOLDER = '05791000-0000-4000-8000-000000000003';
const FEED_ROW = '05791000-0000-4000-8000-000000000004';
const ACTOR = '05791000-0000-4000-8000-000000000005';
const OPERATION = '05791000-0000-4000-8000-000000000006';
const INTENT = '05791000-0000-4000-8000-000000000007';
const CONTENT = 'c'.repeat(64);
const ORIGIN = 'https://catalog-videos-beta.soty.pp.ua';
const output = (index: number) =>
  `05791000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
const url = (index: number) => `${ORIGIN}/v/${String(index).padStart(32, 'a')}.mp4`;

const variations = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 6,
  replacesMaterialId: null,
  idempotencyKey: 'product-catalog:05791000-0000-4000-8000-000000000099',
  catalogVideoProtocolVersion: 1,
  restitchEnabled: true,
  videoVariationCount: 3,
  videoPublication: { mode: 'immediate' },
  restitchDuration: { finalDurationMode: 'custom', customFinalDurationSeconds: 1800 },
  ...overrides
});

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

function plan(count = 3, products = 6): CatalogInitialVideoPlan {
  return createCatalogInitialVideoPlan(
    parseCreateProductCatalogRequest(
      variations({ videoVariationCount: count, productCount: products })
    ) as never,
    products,
    Date.parse('2026-11-28T10:00:00Z')
  );
}

function authorityRpc(options: { state?: string; registered?: number; outputs?: unknown } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
    calls.push([name, parameters]);
    switch (name) {
      case 'service_space_catalog_variant_defaults':
        return effectiveDefaults;
      case 'service_admit_space_catalog_variants':
        return {
          setId: parameters.p_set,
          state: options.state ?? 'preparing',
          requestedCount: (parameters.p_requests as string[]).length,
          registeredCount: options.registered ?? 0,
          variants: []
        };
      case 'service_space_catalog_variant_outputs':
        return options.outputs ?? [0, 1, 2].map(index => ({ index, materialId: output(index) }));
      case 'service_space_catalog_video_link': {
        const index = Number(String(parameters.p_material).slice(-2));
        return { url: url(index), copyId: output(index), state: 'planned', sourceVersion: CONTENT };
      }
      case 'service_catalog_video_r2_kick':
        return null;
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  return { rpc, calls };
}

describe('the request of a catalog with variations in an R2 space', () => {
  it('stays protocol 1 without a Drive executor or the copy option, and is admitted', () => {
    const parsed = parseCreateProductCatalogRequest(
      variations({
        expectedExecutorId: '05791000-0000-4000-8000-0000000000ee',
        copyVideoToR2: true
      })
    );
    const request = spaceCatalogRequest(parsed);
    expect(request).toMatchObject({
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 3
    });
    expect(request).not.toHaveProperty('expectedExecutorId');
    expect(request).not.toHaveProperty('copyVideoToR2');
    expect(spaceCatalogVariations(request)).toBe(true);
    expect(() => assertSpaceCatalogRequest(request)).not.toThrow();
  });

  it('is refused when its link is scheduled: that has no R2 path yet', () => {
    const scheduled = spaceCatalogRequest(
      parseCreateProductCatalogRequest(
        variations({
          videoPublication: {
            mode: 'scheduled',
            localDateTime: '2026-12-01T10:00',
            timeZone: 'Europe/Kyiv',
            resolvedOffset: '+02:00',
            dueAt: '2026-12-01T08:00:00.000Z'
          }
        })
      )
    );
    expect(spaceCatalogVariations(scheduled)).toBe(false);
    expect(() => assertSpaceCatalogRequest(scheduled)).toThrow(TeamFunctionError);
  });
});

describe('the video authority of an R2 space', () => {
  const authority = (rpc: ReturnType<typeof authorityRpc>['rpc'], binding: SpaceVariantBinding) =>
    spaceCatalogVideoAuthority({
      rpc,
      teamId: TEAM,
      actorId: ACTOR,
      sourceMaterialId: VIDEO,
      binding
    });

  it('admits the plan once with frozen settings and reports the progress', async () => {
    const f = authorityRpc({ registered: 1 });
    const binding = { setId: null };
    const p = plan();
    const result = await authority(f.rpc, binding).prepare({ intentId: INTENT, plan: p });
    expect(result).toEqual({ state: 'preparing', registeredCount: 1 });
    expect(binding.setId).toBeNull();
    const admitted = f.calls.find(([name]) => name === 'service_admit_space_catalog_variants')![1];
    expect(admitted).toMatchObject({
      p_team: TEAM,
      p_actor: ACTOR,
      p_intent: INTENT,
      p_set: p.setId,
      p_source: VIDEO,
      p_requests: p.childRequestIds
    });
    // The member's effective settings with the dialog's duration, digested as frozen.
    expect(admitted.p_settings).toMatchObject({
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 1800,
      builtin: { version: 1, start: true, end: true },
      configured: true
    });
    expect(admitted.p_settings_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(f.calls.map(([name]) => name)).not.toContain('service_space_catalog_video_link');
  });

  it('gives every row its variation by the seeded assignment once all are made', async () => {
    const f = authorityRpc({ state: 'ready', registered: 3 });
    const binding: SpaceVariantBinding = { setId: null };
    const p = plan();
    const result = await authority(f.rpc, binding).prepare({ intentId: INTENT, plan: p });
    const assignment = createCatalogVideoAssignment({
      recipeRevision: 1,
      recipeRowIds: p.recipeRowIds,
      variantCount: 3,
      seed: p.assignmentSeed
    });
    const byRow = new Map(
      assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
    );
    expect(result).toEqual({
      state: 'ready',
      videoLinks: p.recipeRowIds.map(row => url(byRow.get(row)!))
    });
    // Each variation is used twice over six rows; the copies were nudged once.
    expect(new Set((result as unknown as { videoLinks: string[] }).videoLinks).size).toBe(3);
    expect(f.calls.filter(([name]) => name === 'service_catalog_video_r2_kick')).toHaveLength(1);
    expect(binding.setId).toBe(p.setId);
  });

  it('refuses an incomplete output list and a scheduled publication', async () => {
    const short = authorityRpc({ state: 'ready', outputs: [{ index: 0, materialId: output(0) }] });
    await expect(
      authority(short.rpc, { setId: null }).prepare({ intentId: INTENT, plan: plan() })
    ).rejects.toMatchObject({ code: 'PROCESS_RESULT_UNCERTAIN' });
    const scheduled = { ...plan() };
    scheduled.preferences = {
      ...scheduled.preferences,
      videoPublication: { mode: 'scheduled' } as never
    };
    const f = authorityRpc();
    await expect(
      authority(f.rpc, { setId: null }).prepare({ intentId: INTENT, plan: scheduled })
    ).rejects.toMatchObject({ code: 'STORAGE_BACKEND_MISMATCH' });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('owes nothing after the link: no Drive publication to verify', async () => {
    const f = authorityRpc();
    const a = authority(f.rpc, { setId: null });
    await a.registerCreated({ intentId: INTENT, plan: plan(), catalogMaterialId: FEED_ROW });
    expect(await a.claimReverify!(INTENT)).toBe('done');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('freezes no settings that cannot make a file', () => {
    expect(spaceVariantSettings(null, undefined)).toBeNull();
    expect(spaceVariantSettings({ ...effectiveDefaults, configured: false }, undefined)).toBeNull();
    expect(
      spaceVariantSettings(effectiveDefaults, {
        finalDurationMode: 'random-centered',
        customFinalDurationSeconds: 1800,
        finalDurationRangeSeconds: [1200, 2400]
      })
    ).toMatchObject({ finalDurationRangeSeconds: [1200, 2400] });
  });
});

describe('the catalog of variations', () => {
  function setup() {
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
    const setId = '05791000-0000-4000-8000-0000000000aa';
    const space = spaceCatalogDeps({
      rpc,
      feeds,
      signal: new AbortController().signal,
      log: vi.fn(),
      variationSet: () => setId
    });
    const links = [url(0), url(1), url(2), url(0), url(1), url(2)];
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
      videoDelivery: { kind: 'assigned' as const, videoLinks: links }
    } as ProductCatalogDeps;
    return { deps, rpc, calls, objects, setId, links };
  }

  it('writes each row with its variation and links the set, never a copy of the original', async () => {
    const f = setup();
    const result = await createProductCatalog(f.deps, variations(), ACTOR);
    expect(result).toMatchObject({ outcome: 'created', catalog: { materialId: FEED_ROW } });
    expect(f.calls.map(([name]) => name)).not.toContain('service_space_catalog_video_link');
    const csv = parseCatalogFeedCsv(new TextDecoder().decode([...f.objects.values()][0]!));
    expect(csv).toHaveLength(8);
    csv.slice(2).forEach((row, index) => {
      expect(row.some(cell => cell.startsWith(f.links[index]!))).toBe(true);
      expect(row.some(cell => cell.includes('drive.google.com'))).toBe(false);
    });
    const linked = f.calls.find(([name]) => name === 'service_link_space_catalog_feed')![1];
    expect(linked.p_record).toMatchObject({ spaceVariantSetId: f.setId, videoLink: url(0) });
  });

  it('is refused without the links its authority proved', async () => {
    const f = setup();
    delete (f.deps as { videoDelivery?: unknown }).videoDelivery;
    await expect(createProductCatalog(f.deps, variations(), ACTOR)).rejects.toMatchObject({
      code: 'STORAGE_BACKEND_MISMATCH'
    });
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe('the dialog read and cancel of an R2 creation', () => {
  const body = { teamId: TEAM, expectedActorId: ACTOR, idempotencyKey: 'product-catalog:x' };

  it('reads the progress, and nothing for a Drive space or a stranger', async () => {
    const progress = {
      outcome: 'preparing_video',
      catalogIntentId: INTENT,
      videoSetId: INTENT,
      requestedCount: 3,
      registeredCount: 1,
      state: 'preparing'
    };
    const ok = { rpc: vi.fn(async () => ({ data: progress, error: null })) };
    expect(await readSpaceCatalogVariants(ok, ACTOR, body)).toEqual(progress);
    expect(ok.rpc).toHaveBeenCalledWith('service_read_space_catalog_variants', {
      p_team: TEAM,
      p_actor: ACTOR,
      p_key: 'product-catalog:x'
    });
    const drive = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'STORAGE_BACKEND_MISMATCH' } }))
    };
    expect(await readSpaceCatalogVariants(drive, ACTOR, body)).toBeNull();
    expect(
      await readSpaceCatalogVariants(ok, ACTOR, { ...body, expectedActorId: TEAM })
    ).toBeNull();
  });

  it('cancels and names a refusal by its code', async () => {
    const canceled = {
      outcome: 'preparing_video',
      catalogIntentId: INTENT,
      videoSetId: INTENT,
      requestedCount: 3,
      registeredCount: 0,
      state: 'canceled'
    };
    const ok = { rpc: vi.fn(async () => ({ data: canceled, error: null })) };
    expect(await cancelSpaceCatalogVariants(ok, ACTOR, body)).toEqual(canceled);
    const late = { rpc: vi.fn(async () => ({ data: null, error: { message: 'WRONG_STATE' } })) };
    await expect(cancelSpaceCatalogVariants(late, ACTOR, body)).rejects.toMatchObject({
      code: 'WRONG_STATE'
    });
  });
});
