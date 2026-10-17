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

  it('does not treat a shared-drive permission on a later page as absent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            permissions: [{ id: 'other', type: 'user', role: 'reader' }],
            nextPageToken: 'page/two'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ permissions: [{ id: 'owned-grant', type: 'anyone', role: 'reader' }] }),
          { status: 200 }
        )
      );
    const drive = new GoogleDriveClient('access-token-with-enough-entropy', fetchImpl);
    await expect(drive.listAnyonePermissions('shared-file')).resolves.toEqual([
      { id: 'owned-grant', role: 'reader' }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [first] = fetchImpl.mock.calls[0]!;
    const [second] = fetchImpl.mock.calls[1]!;
    expect(first).toBeInstanceOf(URL);
    expect(second).toBeInstanceOf(URL);
    if (!(first instanceof URL) || !(second instanceof URL)) throw new Error('Expected URL');
    expect(first.searchParams.get('fields')).toContain('nextPageToken');
    expect(second.searchParams.get('pageToken')).toBe('page/two');
  });

  it('rejects repeated pagination tokens instead of returning an incomplete grant list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ permissions: [], nextPageToken: 'same-page' }), {
        status: 200
      })
    );
    const drive = new GoogleDriveClient('access-token-with-enough-entropy', fetchImpl);
    await expect(drive.listAnyonePermissions('shared-file')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('deletes only the exact permission ID and rejects malformed cleanup targets', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const drive = new GoogleDriveClient('access-token-with-enough-entropy', fetchImpl);
    await drive.deletePermission('item/one', 'grant/two');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/files/item%2Fone/permissions/grant%2Ftwo');
    expect(init.method).toBe('DELETE');
    await expect(drive.deletePermission('item/one', '')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
