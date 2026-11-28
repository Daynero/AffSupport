import { describe, expect, it, vi } from 'vitest';
import { createCatalogVideoAssignment } from '@video-compressor/shared';
import {
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../supabase/functions/_shared/catalog-feed';
import { catalogVideoColumnIndices } from '../supabase/functions/_shared/catalog-updater';
import { catalogFeedIdFor } from '../supabase/functions/drive-ops/catalog-feed-document';
import { spaceCatalogDeps } from '../supabase/functions/drive-ops/catalog-space-source';
import {
  spaceCatalogVideoAuthority,
  type SpaceVariantBinding
} from '../supabase/functions/drive-ops/catalog-space-variants';
import {
  CatalogVideoPreparationPending,
  catalogSegmentRowIds,
  createCatalogInitialVideoPlanV2,
  prepareCatalogInitialVideo,
  type CatalogInitialVideoPlan
} from '../supabase/functions/drive-ops/catalog-video-generation';
import { acceptLaunchBatch } from '../supabase/functions/drive-ops/launch-batch';
import { executeLaunchCatalog } from '../supabase/functions/drive-ops/launch-catalog';
import { prepareLaunchCatalogVideoAdmission } from '../supabase/functions/drive-ops/launch-catalog-video';
import { generateLaunch } from '../supabase/functions/drive-ops/launches';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog';
import type { LaunchConfig } from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';

/**
 * 057 T114/T115: a re-stitched Launch catalog in an R2 space — one video, or one variation set per
 * video creative — and bulk launches there. The Launch freezes the member's settings with the
 * Launch's duration and names no executor (its acceptance admits the space's sets and requires the
 * member's recovery delegation); the catalog step reads every set with those settings, gives each
 * video's rows its own variations by its segment's seed, and links every set; a bulk launch is
 * admitted the same way, member by member. A Drive Launch is admitted exactly as before.
 */

const id = (n: number) => '05791070-0000-4000-8000-' + String(n).padStart(12, '0');
const TEAM = id(1);
const ACTOR = id(2);
const FOLDER = id(3);
const FEED_ROW = id(4);
const OPERATION = id(5);
const INTENT = id(6);
const FIRST = id(10);
const SECOND = id(11);
const ORIGIN = 'https://catalog-videos-beta.soty.pp.ua';
const output = (n: number) => id(100 + n);
const url = (material: string) => `${ORIGIN}/v/${material.slice(-3).padStart(32, 'a')}.mp4`;
const duration = { finalDurationMode: 'custom' as const, customFinalDurationSeconds: 60 };
const defaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'cover',
  startEnabled: false,
  endEnabled: true,
  automaticEndFrame: true,
  finalDurationMode: 'random-40-50',
  customFinalDurationSeconds: 2700,
  sourceMode: 'drive',
  builtin: { version: 1, start: false, end: true },
  configured: true,
  updatedAt: null,
  updatedBy: null
};

function catalog(
  options: { several?: boolean; legacy?: boolean; scheduled?: boolean } = {}
): LaunchConfig {
  const creatives = (options.several ? [10, 11] : [10]).map((n, index, all) => ({
    materialId: id(n),
    alias: `IN${n}`,
    copies: all.length === 1 ? 4 : index === 0 ? 3 : 1,
    pinned: null
  }));
  return launchConfig({
    method: 'catalog',
    materialId: creatives[0]!.materialId,
    creativeAlias: creatives[0]!.alias,
    creativeKind: 'video',
    creatives,
    catalog: {
      productCount: 4,
      restitchEnabled: true,
      ...duration,
      ...(options.legacy
        ? {}
        : {
            catalogVideoProtocolVersion: 1,
            videoVariationCount: 3,
            videoPublication: options.scheduled
              ? {
                  mode: 'scheduled',
                  localDateTime: '2030-12-01T10:00',
                  timeZone: 'Europe/Kyiv',
                  resolvedOffset: '+02:00',
                  dueAt: '2030-12-01T08:00:00.000Z'
                }
              : { mode: 'immediate' }
          })
    }
  }) as LaunchConfig;
}

const foregroundExecutor = {
  protocolVersion: 1 as const,
  enrollmentId: id(8),
  nativeInstanceId: id(9),
  proofDigest: 'a'.repeat(64)
};

/** The admission's reads of an R2 space: the member's defaults and the clock, nothing of Drive. */
function admissionRpc() {
  return vi.fn(async (name: string, _parameters?: Record<string, unknown>) =>
    name === 'service_space_catalog_variant_defaults'
      ? { data: defaults, error: null }
      : name === 'service_catalog_publication_clock'
        ? { data: Date.now(), error: null }
        : { data: null, error: { message: 'unexpected' } }
  );
}

describe('the admission of a re-stitched R2 Launch', () => {
  it('freezes the member’s settings with the Launch’s duration and names no executor', async () => {
    const rpc = admissionRpc();
    const admitted = await prepareLaunchCatalogVideoAdmission(
      { rpc },
      { teamId: TEAM, actorId: ACTOR, launchId: id(7), config: catalog(), spaceStorage: true }
    );
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'service_space_catalog_variant_defaults',
      'service_catalog_publication_clock'
    ]);
    expect(rpc.mock.calls[0]![1]).toEqual({ p_team: TEAM, p_actor: ACTOR });
    expect(admitted.executorId).toBeNull();
    expect(admitted.settings).toMatchObject({ ...duration, sourceMode: 'drive', configured: true });
    expect(admitted.settingsDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(admitted.plan.setId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(admitted.plan.childRequestIds).toHaveLength(3);
    expect(admitted.plan.preferences).toMatchObject({
      restitchEnabled: true,
      restitchDuration: duration
    });
    expect(admitted.plan.preferences).not.toHaveProperty('expectedExecutorId');
    // No ready Drive set of an earlier Launch is looked for.
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_find_launch_catalog_video_reuse'
    );
  });

  it('plans a set per video, each over its own rows', async () => {
    const admitted = await prepareLaunchCatalogVideoAdmission(
      { rpc: admissionRpc() },
      { teamId: TEAM, actorId: ACTOR, config: catalog({ several: true }), spaceStorage: true }
    );
    const segments = admitted.plan.segments!;
    expect(segments.map(segment => [segment.materialId, segment.variantCount])).toEqual([
      [FIRST, 2],
      [SECOND, 1]
    ]);
    expect(segments.every(segment => segment.setId)).toBe(true);
    expect(admitted.segmentAssignments).toHaveLength(2);
    expect(admitted.segmentAssignments![1]!.map(row => row.recipeRowId)).toEqual(
      catalogSegmentRowIds(admitted.plan, segments[1]!).map(row => row.toLowerCase())
    );
  });

  it('never runs in a foreground session', async () => {
    const rpc = admissionRpc();
    await expect(
      prepareLaunchCatalogVideoAdmission(
        { rpc },
        {
          teamId: TEAM,
          actorId: ACTOR,
          config: catalog(),
          spaceStorage: true,
          foregroundExecutor
        }
      )
    ).rejects.toMatchObject({ code: 'STORAGE_BACKEND_MISMATCH' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a Drive one still needs its background executor', async () => {
    const rpc = vi.fn(async (name: string, _parameters?: Record<string, unknown>) =>
      name === 'service_initial_catalog_video_context'
        ? { data: { executorId: null, defaults }, error: null }
        : name === 'service_catalog_publication_clock'
          ? { data: Date.now(), error: null }
          : name === 'service_find_launch_catalog_video_reuse'
            ? { data: null, error: null }
            : { data: null, error: { message: 'unexpected' } }
    );
    await expect(
      prepareLaunchCatalogVideoAdmission(
        { rpc },
        { teamId: TEAM, actorId: ACTOR, launchId: id(7), config: catalog() }
      )
    ).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
    expect(rpc.mock.calls[0]).toEqual([
      'service_initial_catalog_video_context',
      { p_team: TEAM, p_actor: ACTOR, p_source: FIRST, p_executor: null, p_require_executor: false }
    ]);
  });
});

describe('generating a re-stitched R2 Launch', () => {
  function harness() {
    const draft = catalog();
    const caller = {
      rpc: vi.fn(async (name: string) =>
        name === 'find_launch_generation'
          ? { data: null, error: null }
          : name === 'get_launch'
            ? { data: { version: '3', draft }, error: null }
            : { data: null, error: { message: 'unexpected' } }
      )
    };
    const service = {
      rpc: vi.fn(async (name: string, _parameters?: Record<string, unknown>) =>
        name === 'service_launch_sources'
          ? {
              data: {
                ...launchSources,
                schemaVersion: 1,
                agentRowId: draft.agentRowId,
                offerId: draft.offerId,
                buyerId: draft.buyerId,
                materialId: draft.materialId,
                catalogSettingsVersion: null,
                materialType: 'video',
                materialVersion: 'space-v1:' + 'a'.repeat(64)
              },
              error: null
            }
          : name === 'service_accept_launch_catalog_video_generation'
            ? { data: { id: id(20), fence: '1' }, error: null }
            : admissionRpc()(name)
      )
    };
    return { caller, service };
  }

  it('is accepted with the space’s sets to admit and no executor, even one the page named', async () => {
    const h = harness();
    const result = await generateLaunch(
      {
        caller: h.caller,
        service: h.service,
        spaceStorage: true,
        catalogReady: vi.fn(async () => undefined),
        proveSource: vi.fn(async () => undefined)
      },
      {
        teamId: TEAM,
        launchId: id(7),
        expectedVersion: '3',
        requestKey: 'generate-1',
        expectedExecutorId: id(30)
      },
      ACTOR
    );
    expect(result).toMatchObject({ id: id(20), state: 'accepted' });
    const accepted = h.service.rpc.mock.calls.find(
      ([name]) => name === 'service_accept_launch_catalog_video_generation'
    )![1] as Record<string, Record<string, unknown>>;
    expect(accepted.p_video).toMatchObject({ executorId: null });
    expect((accepted.p_video!.plan as Record<string, unknown>).preferences).not.toHaveProperty(
      'expectedExecutorId'
    );
    expect(h.service.rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_initial_catalog_video_context'
    );
  });

  it('is refused a foreground session before anything is read', async () => {
    const h = harness();
    await expect(
      generateLaunch(
        { caller: h.caller, service: h.service, spaceStorage: true },
        {
          teamId: TEAM,
          launchId: id(7),
          expectedVersion: '3',
          requestKey: 'generate-1',
          foregroundExecutor
        },
        ACTOR
      )
    ).rejects.toMatchObject({ code: 'STORAGE_BACKEND_MISMATCH' });
    expect(h.caller.rpc).not.toHaveBeenCalled();
    expect(h.service.rpc).not.toHaveBeenCalled();
  });
});

async function v2Plan(scheduled = false): Promise<CatalogInitialVideoPlan> {
  return createCatalogInitialVideoPlanV2(
    {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 3,
      videoPublication: scheduled
        ? {
            mode: 'scheduled',
            localDateTime: '2030-12-01T10:00',
            timeZone: 'Europe/Kyiv',
            resolvedOffset: '+02:00',
            dueAt: '2030-12-01T08:00:00.000Z'
          }
        : { mode: 'immediate' },
      restitchDuration: duration
    } as never,
    'video',
    [
      { materialId: FIRST, alias: 'IN10', copies: 3 },
      { materialId: SECOND, alias: 'IN11', copies: 1 }
    ],
    4,
    Date.parse('2026-11-28T10:00:00Z')
  );
}

describe('the video authority of a Launch of several R2 videos', () => {
  function authorityRpc(states: Record<string, string>) {
    return vi.fn(async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
      switch (name) {
        case 'service_admit_space_catalog_variants':
          return {
            setId: parameters.p_set,
            state: states[String(parameters.p_set)] ?? 'preparing',
            requestedCount: (parameters.p_requests as string[]).length,
            registeredCount: 0
          };
        case 'service_space_catalog_variant_outputs': {
          const base = parameters.p_set === states.first ? 0 : 10;
          const count = parameters.p_set === states.first ? 2 : 1;
          return Array.from({ length: count }, (_, index) => ({
            index,
            materialId: output(base + index)
          }));
        }
        case 'service_space_catalog_video_link':
          return { url: url(String(parameters.p_material)), state: 'ready' };
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    });
  }
  const authority = (rpc: ReturnType<typeof authorityRpc>, binding: SpaceVariantBinding) =>
    spaceCatalogVideoAuthority({
      rpc,
      teamId: TEAM,
      actorId: ACTOR,
      sourceMaterialId: FIRST,
      binding,
      frozenSettings: { ...defaults, ...duration } as never
    });

  it('reads each video’s set with the Launch’s frozen settings, and names the one that failed', async () => {
    const plan = await v2Plan();
    const [first, second] = plan.segments!;
    const rpc = authorityRpc({ [second!.setId!]: 'unknown' });
    const result = await authority(rpc, { setId: null }).prepare({ intentId: INTENT, plan });
    expect(result).toEqual({ state: 'unknown', registeredCount: 0, failedOrdinal: 1 });
    expect(rpc.mock.calls.map(([, parameters]) => [parameters.p_set, parameters.p_source])).toEqual(
      [
        [first!.setId, FIRST],
        [second!.setId, SECOND]
      ]
    );
    expect(rpc.mock.calls[1]![1]).toMatchObject({
      p_intent: INTENT,
      p_requests: second!.childRequestIds,
      p_settings: { ...defaults, ...duration }
    });
    // The member's current settings are not read: the Launch froze its own.
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_space_catalog_variant_defaults'
    );
  });

  it('gives each video’s rows its own variations by its segment’s seed, and binds every set', async () => {
    const plan = await v2Plan();
    const [first, second] = plan.segments!;
    const rpc = authorityRpc({
      [first!.setId!]: 'ready',
      [second!.setId!]: 'ready',
      first: first!.setId!
    });
    const binding: SpaceVariantBinding = { setId: null };
    const result = await authority(rpc, binding).prepare({ intentId: INTENT, plan });
    const rows = catalogSegmentRowIds(plan, first!);
    const assignment = createCatalogVideoAssignment({
      recipeRevision: 1,
      recipeRowIds: rows,
      variantCount: 2,
      seed: first!.assignmentSeed
    });
    const byRow = new Map(
      assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
    );
    expect(result).toEqual({
      state: 'ready',
      videoLinks: [...rows.map(row => url(output(byRow.get(row.toLowerCase())!))), url(output(10))]
    });
    expect(binding).toMatchObject({
      setId: null,
      setIds: [first!.setId, second!.setId],
      creativeLinks: { [SECOND]: url(output(10)) }
    });
    expect(binding.creativeLinks![FIRST]).toBe(
      'videoLinks' in result ? result.videoLinks[0] : null
    );
  });

  it('waits for every set of a later link for several videos, then binds them all (T117)', async () => {
    const plan = await v2Plan(true);
    const [first, second] = plan.segments!;
    // One set still preparing: the creation waits, so its catalog never names a missing variation.
    const waiting = authorityRpc({ [first!.setId!]: 'ready' });
    await expect(
      authority(waiting, { setId: null }).prepare({ intentId: INTENT, plan })
    ).rejects.toBeInstanceOf(CatalogVideoPreparationPending);
    expect(waiting.mock.calls.map(([name]) => name)).not.toContain(
      'service_space_catalog_variant_outputs'
    );
    const rpc = authorityRpc({
      [first!.setId!]: 'ready',
      [second!.setId!]: 'ready',
      first: first!.setId!
    });
    const binding: SpaceVariantBinding = { setId: null };
    const result = await authority(rpc, binding).prepare({ intentId: INTENT, plan });
    expect(result).toMatchObject({ state: 'ready' });
    expect(binding).toMatchObject({ setId: null, setIds: [first!.setId, second!.setId] });
    // The creation then writes empty cells; the link registers the target per creative.
    expect(await prepareCatalogInitialVideo(authority(rpc, binding), INTENT, plan)).toEqual({
      kind: 'deferred'
    });
  });
});

describe('the catalog of several re-stitched R2 videos', () => {
  it('writes each row with its video’s variation and links every set, no copy of an original', async () => {
    const objects = new Map<string, Uint8Array>();
    const feeds: CatalogFeedStore = {
      feedUrl: key => `${ORIGIN}/${key}`,
      putFeed: vi.fn(async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
        return { etag: '"e"' };
      }),
      readFeed: vi.fn(async () => null),
      removeFeed: vi.fn(async () => undefined),
      purgeUrls: vi.fn(async () => true)
    };
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = vi.fn(
      async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
        calls.push([name, parameters]);
        if (name === 'service_space_catalog_material')
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
                id: parameters.p_material,
                name: 'clip.mp4',
                kind: 'file',
                category: 'video',
                mimeType: 'video/mp4',
                parentFolderId: FOLDER,
                sizeBytes: '5000',
                contentId: 'a'.repeat(64)
              };
        if (name === 'service_space_catalog_names') return [];
        if (name === 'service_commit_space_catalog_feed') return { materialId: FEED_ROW };
        if (name === 'service_link_space_catalog_feed') return { linked: true, variant: 1 };
        throw new Error(`unexpected rpc ${name}`);
      }
    );
    const links = [url(output(1)), url(output(0)), url(output(1)), url(output(10))];
    const space = spaceCatalogDeps({
      rpc,
      feeds,
      signal: new AbortController().signal,
      log: vi.fn(),
      variationSet: () => null,
      variationSets: () => [id(40), id(41)],
      variationLinks: () => links,
      variationLinkOf: material =>
        material === FIRST ? links[0]! : material === SECOND ? links[3]! : null
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
      videoDelivery: { kind: 'assigned', videoLinks: links }
    } as ProductCatalogDeps;
    const request = parseCreateProductCatalogRequest({
      teamId: TEAM,
      videoMaterialId: FIRST,
      sourceLink: 'https://offer.example.test/?sub=1',
      productCount: 4,
      replacesMaterialId: null,
      idempotencyKey: 'launch:05791070-0000-4000-8000-0000000000aa:catalog',
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 3,
      videoPublication: { mode: 'immediate' },
      restitchDuration: duration,
      creativeKind: 'video',
      creatives: [
        { materialId: FIRST, alias: 'IN10', copies: 3 },
        { materialId: SECOND, alias: 'IN11', copies: 1 }
      ]
    });
    await createProductCatalog(deps, request, ACTOR);
    const feed = parseCatalogFeedCsv(
      new TextDecoder().decode(objects.get(`feeds/${await catalogFeedIdFor(OPERATION)}.csv`)!)
    ).slice(2);
    expect(feed.map(row => row[catalogVideoColumnIndices()[0]!]!.split('?')[0])).toEqual(links);
    expect(calls.map(([name]) => name)).not.toContain('service_space_catalog_video_link');
    const record = calls.find(([name]) => name === 'service_link_space_catalog_feed')![1]
      .p_record as Record<string, unknown>;
    expect(record.spaceVariantSetIds).toEqual([id(40), id(41)]);
    expect(record).not.toHaveProperty('spaceVariantSetId');
    expect(record.videoLink).toBe(links[0]);
  });
});

describe('the catalog step of a re-stitched R2 Launch published later', () => {
  it('never waits for a blank catalog’s videos: the creation waited for every variation', async () => {
    const config = {
      ...catalog({ scheduled: true }),
      creatives: undefined,
      creativeKind: undefined
    };
    const rpc = vi.fn(async (name: string) => ({
      error: null,
      data:
        name === 'service_claim_launch_generation'
          ? {
              state: 'running',
              catalogImageContractVersion: 2,
              fence: '2',
              config,
              sources: launchSources,
              advertisingUrl: 'https://synthetic.invalid/'
            }
          : name === 'service_read_launch_catalog_video_context'
            ? { requestPayload: { idempotencyKey: 'launch:generation:catalog' } }
            : name === 'service_restore_registered_launch_catalog'
              ? true
              : name === 'service_publish_launch_generation'
                ? { state: 'succeeded' }
                : null
    }));
    await expect(
      executeLaunchCatalog(
        {
          service: { rpc },
          spaceStorage: true,
          catalog: {} as ProductCatalogDeps,
          driveFor: vi.fn(),
          proveSource: vi.fn(),
          proveCatalog: vi.fn()
        },
        TEAM,
        id(20),
        ACTOR
      )
    ).resolves.toEqual({ state: 'succeeded' });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_read_initial_catalog_video'
    );
  });
});

describe('a bulk launch of an R2 space', () => {
  const command = {
    teamId: TEAM,
    expectedActorId: ACTOR,
    requestKey: id(50),
    expectedExecutorId: id(30),
    items: [{ launchId: id(51), expectedVersion: '3', childRequestKey: id(52) }]
  };
  function batchRpc(config: LaunchConfig) {
    const draft = config;
    return vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      if (name === 'service_launch_batch_context')
        return {
          data: {
            items: [
              {
                ...command.items[0],
                config: draft,
                sources: {
                  ...launchSources,
                  schemaVersion: 1,
                  agentRowId: draft.agentRowId,
                  offerId: draft.offerId,
                  buyerId: draft.buyerId,
                  materialId: draft.materialId,
                  catalogSettingsVersion: null
                },
                errorCode: null
              }
            ]
          },
          error: null
        };
      if (name === 'service_launch_worker_ready') return { data: true, error: null };
      if (name === 'service_accept_launch_batch')
        return { data: { prepared: parameters.p_prepared }, error: null };
      return admissionRpc()(name);
    });
  }
  const prepared = (rpc: ReturnType<typeof batchRpc>) =>
    (
      rpc.mock.calls.find(([name]) => name === 'service_accept_launch_batch')![1]
        .p_prepared as Array<Record<string, unknown>>
    )[0]!;

  it('admits a re-stitched member as a single R2 Launch is, without the Drive context', async () => {
    const rpc = batchRpc(catalog());
    const spaceStorage = vi.fn(async () => true);
    // The test answers no receipt: what was sent for acceptance is what is checked.
    await acceptLaunchBatch({ rpc }, ACTOR, command, { spaceStorage }).catch(() => null);
    const item = prepared(rpc);
    expect(item.errorCode).toBeNull();
    expect(item.video).toMatchObject({ executorId: null });
    expect(
      ((item.video as Record<string, unknown>).plan as Record<string, unknown>).preferences
    ).not.toHaveProperty('expectedExecutorId');
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      'service_initial_catalog_video_context'
    );
    expect(spaceStorage).toHaveBeenCalledWith(TEAM, ACTOR);
  });

  it('refuses a member its catalog cannot make there, before its plan', async () => {
    const rpc = batchRpc(catalog({ legacy: true }));
    await acceptLaunchBatch({ rpc }, ACTOR, command, { spaceStorage: async () => true }).catch(
      () => null
    );
    expect(prepared(rpc)).toMatchObject({ errorCode: 'STORAGE_BACKEND_MISMATCH' });
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('service_launch_worker_ready');
  });

  it('a Drive space’s member reads its Drive context as before', async () => {
    const rpc = batchRpc(catalog());
    await acceptLaunchBatch({ rpc }, ACTOR, command).catch(() => null);
    expect(rpc.mock.calls.map(([name]) => name)).toContain('service_initial_catalog_video_context');
  });
});
