import { describe, expect, it, vi } from 'vitest';
import type { LibraryPlacementMutationRequest } from '@video-compressor/shared';
import {
  applyLibraryGroupMutation,
  canonicalPlacementSegments,
  type LibraryGroupIntent
} from '../supabase/functions/_shared/library.js';
import { executeLibraryOpsCommand } from '../supabase/functions/library-ops/handler.js';

const capabilities = {
  canDownload: true,
  canListChildren: true,
  canAddChildren: true,
  canRename: true,
  canMoveItemWithinDrive: true,
  canMoveItemOutOfDrive: true,
  canModifyContent: true,
  canTrash: true,
  canUntrash: true
};

function live(id: string, parents: string[], folder = false) {
  return {
    id,
    name: id,
    mimeType: folder ? 'application/vnd.google-apps.folder' : 'video/mp4',
    size: folder ? 0 : 10,
    modifiedAt: new Date(0).toISOString(),
    version: '1',
    checksum: null,
    driveId: null,
    resourceKey: null,
    parents,
    trashed: false,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities
  };
}

const intent: LibraryGroupIntent = {
  intentId: '10000000-0000-4000-8000-000000000001',
  teamId: '10000000-0000-4000-8000-000000000002',
  operationId: '10000000-0000-4000-8000-000000000003',
  sourceMaterialId: '10000000-0000-4000-8000-000000000004',
  action: 'move',
  appliedMemberIds: [],
  members: [
    {
      materialId: '10000000-0000-4000-8000-000000000004',
      driveFileId: 'source',
      resourceKey: null,
      parentFolderId: 'old',
      role: 'source'
    },
    {
      materialId: '10000000-0000-4000-8000-000000000005',
      driveFileId: 'transcript',
      resourceKey: null,
      parentFolderId: 'old',
      role: 'transcript'
    }
  ]
};

function drive(failFileId: string | null = null) {
  const files = new Map([
    ['root', live('root', [], true)],
    ['old', live('old', ['root'], true)],
    ['destination', live('destination', ['root'], true)],
    ['source', live('source', ['old'])],
    ['transcript', live('transcript', ['old'])]
  ]);
  return {
    getFile: vi.fn(async (id: string) => files.get(id)),
    updateFileMetadata: vi.fn(
      async ({
        fileId,
        addParentId,
        name
      }: {
        fileId: string;
        addParentId?: string;
        name?: string;
      }) => {
        if (fileId === failFileId) throw new Error('provider details must not escape');
        const current = files.get(fileId)!;
        const updated = {
          ...current,
          parents: addParentId ? [addParentId] : current.parents,
          name: name ?? current.name
        };
        files.set(fileId, updated);
        return updated;
      }
    )
  };
}

describe('Creative Library placement and source-sidecar grouping', () => {
  it('normalizes a stable Stage / Offer / Language / Type hierarchy', () => {
    expect(
      canonicalPlacementSegments({
        stage: 'library',
        offer: '  Summer   Trial ',
        language: 'uk',
        type: 'Video'
      })
    ).toEqual([
      { segment: 'stage', value: 'library' },
      { segment: 'offer', value: 'Summer Trial' },
      { segment: 'language', value: 'uk' },
      { segment: 'type', value: 'Video' }
    ]);
  });

  it('moves a source and current transcript as one checkpointed group', async () => {
    const provider = drive();
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data:
        name === 'service_read_material_group_execution'
          ? {
              intentId: intent.intentId,
              teamId: intent.teamId,
              operationId: intent.operationId,
              sourceMaterialId: intent.sourceMaterialId,
              epoch: 0,
              claimProtocol: 1,
              executorId: null,
              hasPendingDispatch: false,
              acquired: false,
              completed: false,
              appliedMemberIds: []
            }
          : name === 'service_claim_material_group_execution_v2'
            ? {
                intentId: intent.intentId,
                teamId: intent.teamId,
                operationId: intent.operationId,
                sourceMaterialId: intent.sourceMaterialId,
                epoch: 1,
                claimProtocol: 2,
                executorId: args.p_executor,
                hasPendingDispatch: false,
                acquired: true,
                completed: false,
                appliedMemberIds: []
              }
            : true,
      error: null
    }));
    await applyLibraryGroupMutation({
      service: { rpc } as never,
      drive: provider as never,
      rootFolderId: 'root',
      intent,
      destinationFolderId: 'destination'
    });
    expect(provider.updateFileMetadata).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      'service_checkpoint_material_group_execution_v2',
      expect.objectContaining({
        p_intent: intent.intentId,
        p_material: intent.members[1].materialId,
        p_executor: expect.any(String)
      })
    );
  });

  it('marks a partial provider move as reconciling and never reports success', async () => {
    const provider = drive('transcript');
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data:
        name === 'service_read_material_group_execution'
          ? {
              intentId: intent.intentId,
              teamId: intent.teamId,
              operationId: intent.operationId,
              sourceMaterialId: intent.sourceMaterialId,
              epoch: 0,
              claimProtocol: 1,
              executorId: null,
              hasPendingDispatch: false,
              acquired: false,
              completed: false,
              appliedMemberIds: []
            }
          : name === 'service_claim_material_group_execution_v2'
            ? {
                intentId: intent.intentId,
                teamId: intent.teamId,
                operationId: intent.operationId,
                sourceMaterialId: intent.sourceMaterialId,
                epoch: 1,
                claimProtocol: 2,
                executorId: args.p_executor,
                hasPendingDispatch: false,
                acquired: true,
                completed: false,
                appliedMemberIds: []
              }
            : true,
      error: null
    }));
    await expect(
      applyLibraryGroupMutation({
        service: { rpc } as never,
        drive: provider as never,
        rootFolderId: 'root',
        intent,
        destinationFolderId: 'destination'
      })
    ).rejects.toMatchObject({ code: 'GROUP_RECONCILING', retryable: true });
    expect(rpc).toHaveBeenCalledWith('service_mark_material_group_execution_reconciling_v2', {
      p_executor: expect.any(String),
      p_epoch: 1,
      p_intent: intent.intentId,
      p_error_code: 'DRIVE_UNAVAILABLE'
    });
  });

  it('delegates a closed placement request to the provider coordinator', async () => {
    const request: LibraryPlacementMutationRequest = {
      teamId: '10000000-0000-4000-8000-000000000002',
      materialIds: ['10000000-0000-4000-8000-000000000004'],
      targetStage: 'library',
      idempotencyKey: 'placement-test-1'
    };
    const movePlacement = vi.fn(async () => ({ targetStage: 'library' }));
    await expect(
      executeLibraryOpsCommand(
        { action: 'placement_move', request },
        { actorId: 'actor', callerRpc: vi.fn(), serviceRpc: vi.fn(), movePlacement }
      )
    ).resolves.toEqual({ targetStage: 'library' });
    expect(movePlacement).toHaveBeenCalledWith(request);
  });
});
