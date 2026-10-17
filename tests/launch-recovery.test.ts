import { expect, it, vi } from 'vitest';
import {
  cleanupLaunchPermissions,
  cleanupLaunchOutputs,
  runLaunchCatalogRecovery,
  runLaunchVideoCleanupTick,
  type LaunchCleanupDeps,
  type LaunchCleanupAuthority
} from '../supabase/functions/drive-ops/launch-recovery';
import { launchDriveMetadata as file } from './fixtures/launches';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
const output = {
  intentId: 'intent',
  fileId: 'sheet',
  parentId: 'parent',
  credentialId: 'credential'
};
function deps() {
  const drive = {
    getFile: vi.fn(async (_id: string) => file()),
    updateFileMetadata: vi.fn(async () => ({ ...file(), trashed: true }))
  };
  const d: LaunchCleanupDeps = {
    driveFor: vi.fn(async () => drive),
    authorize: vi.fn(async () => 'owned_unpublished' as const),
    cleaned: vi.fn(async () => undefined)
  };
  return { d, drive };
}
const grant = { fileId: 'source-video', permissionId: 'exact-grant', credentialId: 'credential' };
it('removes only a fenced exact source grant and confirms it disappeared', async () => {
  const listAnyonePermissions = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'exact-grant', role: 'reader' }])
    .mockResolvedValueOnce([]);
  const deletePermission = vi.fn(async () => undefined);
  const deps = {
    driveFor: vi.fn(async () => ({ listAnyonePermissions, deletePermission })),
    authorize: vi.fn(async () => 'owned_unpublished' as const),
    cleaned: vi.fn(async () => undefined),
    retained: vi.fn(async () => undefined)
  };
  expect(await cleanupLaunchPermissions(deps, [grant])).toEqual({
    cleaned: 1,
    retained: 0,
    pending: 0
  });
  expect(deps.authorize).toHaveBeenCalledTimes(2);
  expect(deletePermission).toHaveBeenCalledWith('source-video', 'exact-grant');
  expect(deps.cleaned).toHaveBeenCalledWith(grant);
});
it('reconciles a lost delete reply only when the exact grant is absent', async () => {
  const permissions = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'exact-grant', role: 'reader' }])
    .mockResolvedValueOnce([]);
  const deletePermission = vi.fn(async () => {
    throw new Error('lost reply');
  });
  const cleaned = vi.fn(async () => undefined);
  expect(
    await cleanupLaunchPermissions(
      {
        driveFor: async () => ({ listAnyonePermissions: permissions, deletePermission }),
        authorize: async () => 'owned_unpublished',
        cleaned,
        retained: async () => undefined
      },
      [grant]
    )
  ).toMatchObject({ cleaned: 1 });
  expect(cleaned).toHaveBeenCalledOnce();
});
it('keeps cleanup pending when the exact grant survives on a later shared-drive page', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'DELETE') throw new Error('lost delete reply');
    const page = url instanceof URL ? url.searchParams.get('pageToken') : null;
    return new Response(
      JSON.stringify(
        page === null
          ? {
              permissions: [{ id: 'other', type: 'user', role: 'reader' }],
              nextPageToken: 'page-2'
            }
          : { permissions: [{ id: 'exact-grant', type: 'anyone', role: 'reader' }] }
      ),
      { status: 200 }
    );
  });
  const drive = new GoogleDriveClient('access-token-with-enough-entropy', fetchImpl);
  const cleaned = vi.fn();
  expect(
    await cleanupLaunchPermissions(
      {
        driveFor: async () => drive,
        authorize: async () => 'owned_unpublished',
        cleaned,
        retained: async () => undefined
      },
      [grant]
    )
  ).toEqual({ cleaned: 0, retained: 0, pending: 1 });
  expect(cleaned).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
});
it('keeps changed, retained and uncertain source grants pending without deleting them', async () => {
  const deletePermission = vi.fn();
  const drive = {
    listAnyonePermissions: vi.fn(async () => [{ id: 'exact-grant', role: 'writer' }]),
    deletePermission
  };
  const cleaned = vi.fn();
  const deps = {
    driveFor: vi.fn(async () => drive),
    authorize: vi.fn(async (): Promise<LaunchCleanupAuthority> => 'owned_unpublished'),
    cleaned,
    retained: vi.fn(async () => undefined)
  };
  expect((await cleanupLaunchPermissions(deps, [grant])).pending).toBe(1);
  expect(deletePermission).not.toHaveBeenCalled();
  deps.authorize.mockResolvedValueOnce('retained');
  expect((await cleanupLaunchPermissions(deps, [grant])).retained).toBe(1);
  expect(deps.retained).toHaveBeenCalledWith(grant);
  expect(deps.driveFor).toHaveBeenCalledTimes(1);
  deps.authorize.mockResolvedValueOnce('unknown');
  expect((await cleanupLaunchPermissions(deps, [grant])).pending).toBe(1);
  expect(cleaned).not.toHaveBeenCalled();
});
it('trashes only an exact owned unpublished marker and checkpoints the receipt', async () => {
  const { d, drive } = deps();
  expect(await cleanupLaunchOutputs(d, [output])).toEqual({ cleaned: 1, retained: 0, pending: 0 });
  expect(d.authorize).toHaveBeenCalledTimes(2);
  expect(drive.updateFileMetadata).toHaveBeenCalledWith({ fileId: 'sheet', trashed: true });
  expect(d.cleaned).toHaveBeenCalledWith(output);
});

it('cleans only a service-authorized unregistered marked video and records its receipt', async () => {
  const id = '72000000-0000-4000-8000-000000000051';
  const plan = {
    teamId: id,
    generationId: id,
    operationId: id,
    credentialId: id,
    parentId: 'parent',
    fence: '1'
  };
  const video = {
    ...file(),
    id: 'video',
    mimeType: 'video/mp4',
    appProperties: { 'soty.launch.restitch.operation': id }
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    error: null,
    data:
      name === 'service_claim_launch_video_cleanup'
        ? [plan]
        : name === 'service_authorize_launch_video_cleanup'
          ? 'owned_unpublished'
          : name === 'service_finish_launch_video_cleanup' && args.p_cleaned_file === 'video'
            ? 'cleaned'
            : 'pending'
  }));
  const drive = {
    findLaunchRestitchFiles: vi.fn(async () => [video]),
    getFile: vi.fn(async () => file()),
    updateFileMetadata: vi.fn(async () => ({ ...video, trashed: true }))
  };
  expect(await runLaunchVideoCleanupTick({ rpc }, async () => drive)).toEqual({
    completed: 1,
    pending: 0
  });
  expect(drive.updateFileMetadata).toHaveBeenCalledWith({ fileId: 'video', trashed: true });
  expect(rpc).toHaveBeenCalledWith(
    'service_finish_launch_video_cleanup',
    expect.objectContaining({ p_operation: id, p_cleaned_file: 'video' })
  );
});

it('leaves an unknown or unowned native upload pending without a Drive mutation', async () => {
  const id = '72000000-0000-4000-8000-000000000052';
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_claim_launch_video_cleanup'
        ? [
            {
              teamId: id,
              generationId: id,
              operationId: id,
              credentialId: id,
              parentId: 'parent',
              fence: '1'
            }
          ]
        : name === 'service_authorize_launch_video_cleanup'
          ? 'unknown'
          : 'pending'
  }));
  const drive = {
    findLaunchRestitchFiles: vi.fn(async () => [
      {
        ...file(),
        id: 'video',
        mimeType: 'video/mp4',
        appProperties: { 'soty.launch.restitch.operation': id }
      }
    ]),
    getFile: vi.fn(async () => file()),
    updateFileMetadata: vi.fn()
  };
  expect(await runLaunchVideoCleanupTick({ rpc }, async () => drive)).toEqual({
    completed: 0,
    pending: 1
  });
  expect(drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith(
    'service_finish_launch_video_cleanup',
    expect.objectContaining({ p_cleaned_file: null })
  );
});

it('reconciles a previously trashed marked video after a lost provider reply', async () => {
  const id = '72000000-0000-4000-8000-000000000053';
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_claim_launch_video_cleanup'
        ? [
            {
              teamId: id,
              generationId: id,
              operationId: id,
              credentialId: id,
              parentId: 'parent',
              fence: '1'
            }
          ]
        : name === 'service_authorize_launch_video_cleanup'
          ? 'owned_unpublished'
          : 'cleaned'
  }));
  const drive = {
    findLaunchRestitchFiles: vi.fn(async () => [
      {
        ...file(),
        id: 'video',
        mimeType: 'video/mp4',
        trashed: true,
        capabilities: { ...file().capabilities, canTrash: false },
        appProperties: { 'soty.launch.restitch.operation': id }
      }
    ]),
    getFile: vi.fn(async () => file()),
    updateFileMetadata: vi.fn()
  };
  expect(await runLaunchVideoCleanupTick({ rpc }, async () => drive)).toEqual({
    completed: 1,
    pending: 0
  });
  expect(drive.updateFileMetadata).not.toHaveBeenCalled();
});
it('retains published or referenced resources before any provider call', async () => {
  const { d, drive } = deps();
  vi.mocked(d.authorize).mockResolvedValue('retained');
  expect(await cleanupLaunchOutputs(d, [output])).toEqual({ cleaned: 0, retained: 1, pending: 0 });
  expect(drive.getFile).not.toHaveBeenCalled();
  expect(drive.updateFileMetadata).not.toHaveBeenCalled();
});
it('refuses an ownership mismatch and a changed fence after provider proof', async () => {
  const a = deps();
  a.drive.getFile.mockResolvedValue({ ...file(), ownedByMe: false });
  expect((await cleanupLaunchOutputs(a.d, [output])).pending).toBe(1);
  expect(a.drive.updateFileMetadata).not.toHaveBeenCalled();
  const b = deps();
  vi.mocked(b.d.authorize)
    .mockResolvedValueOnce('owned_unpublished')
    .mockResolvedValueOnce('unknown');
  expect((await cleanupLaunchOutputs(b.d, [output])).pending).toBe(1);
  expect(b.drive.updateFileMetadata).not.toHaveBeenCalled();
});
it('keeps a lost trash reply pending and reconciles an already trashed own file on retry', async () => {
  const { d, drive } = deps();
  drive.updateFileMetadata.mockRejectedValueOnce(new Error('private provider payload'));
  expect((await cleanupLaunchOutputs(d, [output])).pending).toBe(1);
  expect(d.cleaned).not.toHaveBeenCalled();
  drive.getFile.mockResolvedValue({ ...file(), trashed: true });
  expect((await cleanupLaunchOutputs(d, [output])).cleaned).toBe(1);
  expect(drive.updateFileMetadata).toHaveBeenCalledTimes(1);
});
it('reconciles an already trashed shared-drive catalog without requiring canTrash again', async () => {
  const { d, drive } = deps();
  drive.getFile.mockImplementation(async id =>
    id === 'parent'
      ? {
          ...file(),
          id: 'parent',
          driveId: 'shared-drive',
          mimeType: 'application/vnd.google-apps.folder'
        }
      : {
          ...file(),
          driveId: 'shared-drive',
          ownedByMe: false,
          trashed: true,
          capabilities: { ...file().capabilities, canTrash: false }
        }
  );
  expect(await cleanupLaunchOutputs(d, [output])).toEqual({
    cleaned: 1,
    retained: 0,
    pending: 0
  });
  expect(drive.updateFileMetadata).not.toHaveBeenCalled();
});
it('does not treat a missing provider response as proof of deletion and bounds the batch', async () => {
  const { d, drive } = deps();
  drive.getFile.mockRejectedValue(new Error('not found or inaccessible'));
  expect(await cleanupLaunchOutputs(d, [output, output, output, output], 2)).toEqual({
    cleaned: 0,
    retained: 0,
    pending: 4
  });
  expect(drive.getFile).toHaveBeenCalledTimes(2);
  expect(d.cleaned).not.toHaveBeenCalled();
});

it('bounds hosted catalog recovery and distinguishes committed results from pending work', async () => {
  const id = '72000000-0000-4000-8000-000000000050';
  const rpc = vi.fn(async (name: string) =>
    name === 'service_settle_launch_authority_losses'
      ? { data: 0, error: null }
      : {
          data: [
            { teamId: id, generationId: id, actorId: id },
            { teamId: id, generationId: id, actorId: id }
          ],
          error: null
        }
  );
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ state: 'succeeded' })
    .mockRejectedValueOnce(new Error('private provider payload'));
  expect(await runLaunchCatalogRecovery({ rpc }, execute)).toEqual({ completed: 1, pending: 1 });
  expect(rpc).toHaveBeenCalledWith('service_list_launch_catalog_recovery', { p_limit: 3 });
  expect(execute).toHaveBeenCalledTimes(2);
});
