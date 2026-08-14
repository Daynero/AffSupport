import { describe, expect, it, vi } from 'vitest';
import {
  parseLibraryShareCopyRequest,
  parseLibraryShareCopyResult,
  type LibraryShareCopyRequest
} from '@video-compressor/shared';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive.js';
import { executeLibraryOpsCommand } from '../supabase/functions/library-ops/handler.js';

const TEAM_ID = '47000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '47000000-0000-4000-8000-000000000002';

describe('Creative Library exact Drive sharing', () => {
  it('lists and creates Anyone-reader permission only on the exact encoded item', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            permissions: [
              { id: 'domain', type: 'domain', role: 'reader' },
              { id: 'anyone', type: 'anyone', role: 'reader' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'created', type: 'anyone', role: 'reader' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const drive = new GoogleDriveClient('access-token-with-enough-entropy', fetchImpl);
    await expect(drive.listAnyonePermissions('item/one')).resolves.toEqual([
      { id: 'anyone', role: 'reader' }
    ]);
    await expect(drive.createAnyoneReaderPermission('item/one')).resolves.toEqual({
      id: 'created',
      role: 'reader'
    });
    const [listUrl] = fetchImpl.mock.calls[0];
    const [createUrl, createInit] = fetchImpl.mock.calls[1];
    expect(String(listUrl)).toContain('/files/item%2Fone/permissions');
    expect(String(createUrl)).toContain('/files/item%2Fone/permissions');
    expect(createInit?.method).toBe('POST');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      type: 'anyone',
      role: 'reader',
      allowFileDiscovery: false
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires explicit approval before a remembered restricted-share choice', () => {
    expect(
      parseLibraryShareCopyRequest({
        teamId: TEAM_ID,
        materialId: MATERIAL_ID,
        allowIfRestricted: false,
        rememberChoice: true,
        idempotencyKey: 'share-copy-12345678'
      })
    ).toBeNull();
    expect(
      parseLibraryShareCopyResult({
        state: 'confirmation_required',
        url: 'https://drive.google.com/file/d/exact/view',
        public: false,
        canShare: true
      })
    ).toMatchObject({ state: 'confirmation_required', canShare: true });
  });

  it('delegates one closed request without mutating any unselected material', async () => {
    const request: LibraryShareCopyRequest = {
      teamId: TEAM_ID,
      materialId: MATERIAL_ID,
      allowIfRestricted: true,
      rememberChoice: false,
      idempotencyKey: 'share-copy-12345678'
    };
    const shareMaterial = vi.fn().mockResolvedValue({
      state: 'ready',
      url: 'https://drive.google.com/file/d/exact/view',
      public: true,
      permissionChanged: true
    });
    await executeLibraryOpsCommand(
      { action: 'share_copy', request },
      { actorId: 'actor', callerRpc: vi.fn(), serviceRpc: vi.fn(), shareMaterial }
    );
    expect(shareMaterial).toHaveBeenCalledTimes(1);
    expect(shareMaterial).toHaveBeenCalledWith(request);
  });
});
