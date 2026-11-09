import { expect, it, vi } from 'vitest';
import {
  startCatalogUpdaterVariants,
  readCatalogUpdaterVariants
} from '../supabase/functions/drive-ops/updater-variants';
const id = (n: number) => 'c1720000-0000-4000-8000-' + String(n).padStart(12, '0');
const identity = {
  teamId: id(1),
  actorId: id(2),
  catalogMaterialId: id(3),
  requestId: id(4),
  requestedCount: 1,
  profileVersion: 1
};
it('preserves definitive admission refusal without claiming an unknown accepted command', async () => {
  const drive = vi.fn();
  await expect(
    startCatalogUpdaterVariants(
      { rpc: async () => ({ data: null, error: { message: 'WRONG_STATE' } }) },
      identity,
      drive
    )
  ).rejects.toThrow('WRONG_STATE');
  expect(drive).not.toHaveBeenCalled();
});
it('keeps a postadmission provider failure uncertain so the original command can be read or canceled', async () => {
  const settings = {
    configured: true,
    operation: 'restitch',
    sourceMode: 'legacy',
    startImageIds: [id(30)],
    endImageIds: [],
    fitMode: 'cover',
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 60,
    updatedAt: '',
    updatedBy: null
  };
  const row = {
    request_id: id(4),
    team_id: id(1),
    actor_id: id(2),
    catalog_material_id: id(3),
    set_id: id(5),
    attempt_id: id(6),
    executor_id: id(7),
    source_material_id: id(8),
    requested_count: 1,
    recipe_row_ids: [id(9)],
    child_request_ids: [id(10)],
    assignment_seed: 'a'.repeat(64),
    settings_snapshot: settings,
    provider_context: {
      fileId: 'source',
      connectionId: id(11),
      credentialId: id(12),
      rootFolderId: 'root',
      version: '1'
    },
    canceled_at: null
  };
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data: name === 'service_accept_catalog_updater_variants' ? row : null
  }));
  await expect(
    startCatalogUpdaterVariants({ rpc }, identity, async () => {
      throw new Error('https://private-provider/?token=secret');
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(rpc.mock.calls.map(call => call[0])).toContain('service_read_catalog_video_acceptance');
});
it('returns authoritative missing only for the exact original actor/catalog/request scope', async () => {
  const rpc = vi.fn(async () => ({ error: null, data: null }));
  expect(await readCatalogUpdaterVariants({ rpc }, identity)).toBeNull();
  expect(rpc).toHaveBeenCalledWith('service_read_catalog_updater_variants', {
    p_team: id(1),
    p_actor: id(2),
    p_catalog: id(3),
    p_request: id(4)
  });
});
it('explicit resume uses original admission without reopening the round', async () => {
  const { resumeCatalogUpdaterVariants } =
    await import('../supabase/functions/drive-ops/updater-variants');
  const row = {
    request_id: id(4),
    team_id: id(1),
    actor_id: id(2),
    catalog_material_id: id(3),
    set_id: id(5),
    attempt_id: id(6),
    executor_id: id(7),
    source_material_id: id(8),
    requested_count: 2,
    profile_version: 7,
    recipe_row_ids: [id(9), id(10)],
    child_request_ids: [id(11), id(12)],
    assignment_seed: 'a'.repeat(64),
    settings_snapshot: { configured: true },
    provider_context: {},
    canceled_at: null
  };
  const rpc = vi.fn(async (..._args: unknown[]) => ({ error: null, data: row }));
  await expect(resumeCatalogUpdaterVariants({ rpc }, identity, vi.fn())).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(rpc).toHaveBeenCalledWith('service_resume_catalog_updater_variants', {
    p_team: id(1),
    p_actor: id(2),
    p_catalog: id(3),
    p_request: id(4)
  });
  expect(rpc.mock.calls.some(call => call[0] === 'service_accept_catalog_updater_variants')).toBe(
    false
  );
});
it('the existing cron consumer proves each distinct output once and attaches a pending target without writing catalog cells', async () => {
  const { settleCatalogUpdaterVariantTargets } =
    await import('../supabase/functions/drive-ops/updater-variants');
  const { catalogPublicationSourceIdentity } =
    await import('../packages/shared/src/team/catalog-publication-source');
  const live = {
    id: 'copy',
    parents: ['root'],
    trashed: false,
    shortcutTargetId: null,
    checksum: 'a'.repeat(32),
    size: 4,
    mimeType: 'video/mp4',
    version: '1',
    resourceKey: null,
    capabilities: { canDownload: true, canShare: true }
  };
  const version = await catalogPublicationSourceIdentity({
    materialId: id(8),
    connectionId: id(11),
    fileId: live.id,
    checksum: live.checksum,
    mimeType: live.mimeType,
    sizeBytes: live.size,
    driveVersion: live.version
  });
  const rows = [0, 1].map(index => ({
    rowId: id(20 + index),
    ordinal: index + 1,
    materialId: id(8),
    connectionId: id(11),
    fileId: 'copy',
    credentialId: id(12),
    rootFolderId: 'root',
    sourceVersion: version
  }));
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_list_catalog_updater_variant_targets'
        ? [identity]
        : name === 'service_read_catalog_updater_variants'
          ? { state: 'ready', setId: id(5) }
          : name === 'service_catalog_updater_variant_outputs'
            ? rows
            : name === 'service_attach_catalog_updater_variant_target'
              ? { target: { kind: 'video_set', videoSetId: id(5), recipeRevision: 1 } }
              : null
  }));
  const getFile = vi.fn(async () => live),
    listAnyonePermissions = vi.fn(async () => [{ id: 'anyone' }]);
  const driveFor = vi.fn(
    async () =>
      ({
        getFile,
        listAnyonePermissions
      }) as unknown as import('../supabase/functions/_shared/drive').GoogleDriveClient
  );
  expect(await settleCatalogUpdaterVariantTargets({ rpc }, driveFor)).toEqual({
    attached: 1,
    unknown: 0
  });
  expect(getFile).toHaveBeenCalledTimes(2);
  expect(listAnyonePermissions).toHaveBeenCalledOnce();
  expect(rpc.mock.calls.map(call => call[0])).toContain(
    'service_attach_catalog_updater_variant_target'
  );
});
