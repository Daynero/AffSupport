import { describe, expect, it, vi } from 'vitest';
import { prepareLaunchCatalogVideoAdmission } from '../supabase/functions/drive-ops/launch-catalog-video';
import {
  assertSpaceLaunchCatalog,
  proveSpaceLaunch,
  proveSpaceLaunchSource,
  spaceLaunchMaterialVersion
} from '../supabase/functions/drive-ops/launch-space-source';
import type { LaunchConfig, LaunchSourceSnapshot } from '../packages/shared/src/team/launches';
import type { CatalogVideoPublicationRequest } from '../packages/shared/src/team/catalog-publication';
import { launchConfig } from './fixtures/launches';

/**
 * 057 T103/T104: a Launch of an R2 space. Its source is named by content and proven in the space;
 * what its catalog cannot make there yet (a legacy request, a later link for several creatives or
 * pictures) is refused before the Launch is accepted, and its admission reads no Drive video
 * context. Re-stitched Launches are T115's (launch-space-catalog-variants.test.ts). A Drive
 * Launch is admitted exactly as before.
 */

const id = (n: number) => '05791060-0000-4000-8000-' + String(n).padStart(12, '0');
const TEAM = id(1);
const ACTOR = id(2);
const FOLDER = id(3);
const scheduled = {
  mode: 'scheduled' as const,
  localDateTime: '2030-12-01T10:00',
  timeZone: 'Europe/Kyiv',
  resolvedOffset: '+02:00',
  dueAt: '2030-12-01T08:00:00.000Z'
};

function catalog(
  options: {
    restitch?: boolean;
    image?: boolean;
    several?: boolean;
    publication?: CatalogVideoPublicationRequest;
    legacy?: boolean;
  } = {}
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
    creativeKind: options.image ? 'image' : 'video',
    creatives,
    catalog: {
      productCount: 4,
      restitchEnabled: options.restitch ?? false,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 60,
      ...(options.legacy
        ? {}
        : {
            catalogVideoProtocolVersion: 1,
            videoVariationCount: options.restitch ? 3 : 1,
            videoPublication: options.publication ?? { mode: 'immediate' }
          })
    }
  }) as LaunchConfig;
}

describe('an R2 space Launch catalog', () => {
  it('is refused what its catalog cannot make there yet', () => {
    expect(() => assertSpaceLaunchCatalog(catalog())).not.toThrow();
    expect(() => assertSpaceLaunchCatalog(catalog({ several: true }))).not.toThrow();
    expect(() => assertSpaceLaunchCatalog(catalog({ image: true, several: true }))).not.toThrow();
    expect(() => assertSpaceLaunchCatalog(catalog({ publication: scheduled }))).not.toThrow();
    // T115: re-stitched, one video or several, at once; one video published later too.
    expect(() => assertSpaceLaunchCatalog(catalog({ restitch: true }))).not.toThrow();
    expect(() =>
      assertSpaceLaunchCatalog(catalog({ restitch: true, several: true }))
    ).not.toThrow();
    expect(() =>
      assertSpaceLaunchCatalog(catalog({ restitch: true, publication: scheduled }))
    ).not.toThrow();
    // T117: a later link for several creatives or pictures is a target per creative.
    expect(() =>
      assertSpaceLaunchCatalog(catalog({ restitch: true, several: true, publication: scheduled }))
    ).not.toThrow();
    expect(() =>
      assertSpaceLaunchCatalog(catalog({ several: true, publication: scheduled }))
    ).not.toThrow();
    expect(() =>
      assertSpaceLaunchCatalog(catalog({ image: true, publication: scheduled }))
    ).not.toThrow();
    const refused: Array<[LaunchConfig, string]> = [
      [catalog({ legacy: true }), 'STORAGE_BACKEND_MISMATCH'],
      [catalog({ legacy: true, several: true }), 'MULTI_CREATIVE_UNSUPPORTED']
    ];
    for (const [config, code] of refused)
      expect(() => assertSpaceLaunchCatalog(config)).toThrow(expect.objectContaining({ code }));
    expect(() =>
      assertSpaceLaunchCatalog(launchConfig({ method: 'other' }) as LaunchConfig)
    ).not.toThrow();
  });

  it('is admitted without the Drive video context', async () => {
    const rpc = vi.fn(async (name: string) =>
      name === 'service_catalog_publication_clock'
        ? { data: Date.now(), error: null }
        : { data: null, error: { message: 'unexpected' } }
    );
    const admitted = await prepareLaunchCatalogVideoAdmission(
      { rpc },
      { teamId: TEAM, actorId: ACTOR, config: catalog({ several: true }), spaceStorage: true }
    );
    expect(admitted.executorId).toBeNull();
    expect(admitted.plan.segments).toHaveLength(2);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['service_catalog_publication_clock']);
  });

  it('a Drive Launch still reads its video context', async () => {
    const rpc = vi.fn(async (name: string) =>
      name === 'service_catalog_publication_clock'
        ? { data: Date.now(), error: null }
        : name === 'service_initial_catalog_video_context'
          ? { data: { executorId: null, defaults: {} }, error: null }
          : { data: null, error: { message: 'unexpected' } }
    );
    await prepareLaunchCatalogVideoAdmission(
      { rpc },
      { teamId: TEAM, actorId: ACTOR, config: catalog() }
    );
    expect(rpc).toHaveBeenCalledWith('service_initial_catalog_video_context', {
      p_team: TEAM,
      p_actor: ACTOR,
      p_source: id(10),
      p_executor: null,
      p_require_executor: false
    });
  });
});

describe('an R2 space Launch source', () => {
  const material = (
    materialId: string,
    contentId: string,
    extra: Record<string, unknown> = {}
  ) => ({
    id: materialId,
    name: 'clip.mp4',
    kind: 'file',
    category: 'video',
    mimeType: 'video/mp4',
    parentFolderId: FOLDER,
    sizeBytes: '5000',
    contentId,
    ...extra
  });
  const source = (versions: [string, string]): LaunchSourceSnapshot =>
    ({
      schemaVersion: 1,
      accountId: id(20),
      agentRowId: id(21),
      offerId: id(22),
      buyerId: id(23),
      materialId: id(10),
      social: 'g1',
      agentId: '1234567892',
      offer: 'Offer',
      buyer: 'buyer',
      materialType: 'video',
      materialVersion: versions[0],
      catalogSettingsVersion: null,
      materials: [
        { materialId: id(10), type: 'video', version: versions[0] },
        { materialId: id(11), type: 'video', version: versions[1] }
      ]
    }) as LaunchSourceSnapshot;

  it('is proven creative by creative at the content the Launch froze', async () => {
    const rpc = vi.fn(async (_name: string, parameters: Record<string, unknown>) =>
      parameters.p_material === FOLDER
        ? material(FOLDER, '', {
            kind: 'folder',
            category: null,
            contentId: null,
            parentFolderId: null
          })
        : material(
            String(parameters.p_material),
            parameters.p_material === id(10) ? 'a'.repeat(64) : 'b'.repeat(64)
          )
    );
    const frozen = source([
      spaceLaunchMaterialVersion('a'.repeat(64)),
      spaceLaunchMaterialVersion('b'.repeat(64))
    ]);
    await proveSpaceLaunchSource(rpc, TEAM, ACTOR, frozen);
    expect(rpc.mock.calls.map(([, parameters]) => parameters.p_material)).toEqual([id(10), id(11)]);
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p_team: TEAM,
      p_actor: ACTOR,
      p_permission: 'view'
    });
    await expect(
      proveSpaceLaunchSource(
        rpc,
        TEAM,
        ACTOR,
        source([frozen.materialVersion!, spaceLaunchMaterialVersion('c'.repeat(64))])
      )
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    rpc.mockClear();
    await proveSpaceLaunch(rpc, TEAM, ACTOR, catalog({ several: true }), frozen);
    expect(rpc.mock.calls.at(-1)![1]).toEqual({
      p_team: TEAM,
      p_material: FOLDER,
      p_actor: ACTOR,
      p_permission: 'upload'
    });
    await expect(
      proveSpaceLaunch(rpc, TEAM, ACTOR, catalog({ image: true, several: true }), frozen)
    ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });
});
