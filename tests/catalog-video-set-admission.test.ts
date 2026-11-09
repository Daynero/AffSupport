import { expect, it } from 'vitest';
import { catalogVideoSettingsDigest } from '../supabase/functions/drive-ops/catalog-video-set-admission.ts';
import type { TeamRestitchDefaults } from '@video-compressor/shared';
it('canonicalizes rendering settings independently of metadata and transport key order', async () => {
  const first = {
    configured: true,
    operation: 'restitch',
    updatedAt: 'yesterday',
    nested: { b: 2, a: 1 }
  } as unknown as TeamRestitchDefaults;
  const second = {
    nested: { a: 1, b: 2 },
    updatedAt: 'today',
    operation: 'restitch',
    configured: true
  } as unknown as TeamRestitchDefaults;
  expect(await catalogVideoSettingsDigest(first)).toBe(await catalogVideoSettingsDigest(second));
  expect(await catalogVideoSettingsDigest({ ...second, operation: 'unstitch' })).not.toBe(
    await catalogVideoSettingsDigest(first)
  );
});

it('replays accepted identity without refreshing provider metadata or resampling children', async () => {
  const { acceptCatalogVideoSet } =
    await import('../supabase/functions/drive-ops/catalog-video-set-admission.ts');
  const { createCatalogVideoAssignment } = await import('@video-compressor/shared');
  const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const settings = { configured: true, operation: 'restitch' } as TeamRestitchDefaults;
  const recipe = {
    recipeRevision: 1,
    recipeRowIds: [id(7)],
    variantCount: 1,
    seed: 'a'.repeat(64)
  };
  const source = {
    materialId: id(3),
    teamId: id(1),
    actorId: id(2),
    connectionId: id(9),
    fileId: 'fixture',
    version: 'original',
    checksum: 'b'.repeat(32),
    sizeBytes: 4,
    mimeType: 'video/mp4'
  };
  const snapshot = {
    setId: id(4),
    revision: 1,
    children: [{ index: 0, requestId: id(8), operationId: null, state: 'queued', outputId: null }]
  };
  let proves = 0;
  const result = await acceptCatalogVideoSet(
    {
      rpc: async () => ({
        error: null,
        data: {
          snapshot,
          parentState: 'accepted',
          source,
          settingsDigest: await catalogVideoSettingsDigest(settings),
          catalogIntentId: id(5),
          updateAttemptId: null,
          assignment: createCatalogVideoAssignment(recipe)
        }
      })
    },
    {
      setId: id(4),
      teamId: id(1),
      actorId: id(2),
      executorId: id(6),
      catalogMaterialId: null,
      catalogIntentId: id(5),
      updateAttemptId: null,
      sourceMaterialId: id(3),
      settings,
      requestedCount: 1,
      recipe,
      childRequestIds: [id(8)]
    },
    async () => {
      proves++;
      return { ...source, version: 'changed-today' };
    }
  );
  expect(proves).toBe(0);
  expect(result.source.version).toBe('original');
  expect(result.snapshot).toEqual(snapshot);
});
