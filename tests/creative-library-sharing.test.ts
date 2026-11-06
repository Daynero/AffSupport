import { describe, expect, it, vi } from 'vitest';
import {
  parseLibraryShareCopyRequest,
  parseLibraryShareCopyResult,
  type LibraryShareCopyRequest
} from '@video-compressor/shared';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive.js';
import { executeLibraryOpsCommand } from '../supabase/functions/library-ops/handler.js';

const TEAM_ID = '47000000-0000-4000-8000-000000000001';
const ACTOR_ID = '47000000-0000-4000-8000-000000000003';
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
      idempotencyKey: `share.v2:${Date.now()}:${crypto.randomUUID()}`,
      expectedActorId: ACTOR_ID,
      expectedShareVersion: null
    };
    const shareMaterial = vi.fn().mockResolvedValue({
      state: 'ready',
      url: 'https://drive.google.com/file/d/exact/view',
      public: true,
      permissionChanged: true
    });
    await executeLibraryOpsCommand(
      { action: 'share_copy', request },
      { actorId: ACTOR_ID, callerRpc: vi.fn(), serviceRpc: vi.fn(), shareMaterial }
    );
    expect(shareMaterial).toHaveBeenCalledTimes(1);
    expect(shareMaterial).toHaveBeenCalledWith(request);
  });
});

it('keeps legacy combined Copy/Share clients read-only instead of bypassing explicit approval', async () => {
  const request: LibraryShareCopyRequest = {
    teamId: TEAM_ID,
    materialId: MATERIAL_ID,
    allowIfRestricted: true,
    rememberChoice: true,
    idempotencyKey: 'legacy-share-12345678'
  };
  const shareMaterial = vi.fn().mockResolvedValue({ state: 'confirmation_required' });
  await executeLibraryOpsCommand(
    { action: 'share_copy', request },
    { actorId: ACTOR_ID, callerRpc: vi.fn(), serviceRpc: vi.fn(), shareMaterial }
  );
  expect(shareMaterial).toHaveBeenCalledWith({
    ...request,
    allowIfRestricted: false,
    rememberChoice: false
  });
});
it.each([false, true])(
  'rejects a changed actor before even resolving a link (mutation=%s)',
  async allowIfRestricted => {
    const shareMaterial = vi.fn();
    await expect(
      executeLibraryOpsCommand(
        {
          action: 'share_copy',
          request: {
            teamId: TEAM_ID,
            materialId: MATERIAL_ID,
            allowIfRestricted,
            rememberChoice: false,
            expectedActorId: ACTOR_ID,
            expectedShareVersion: null,
            idempotencyKey: `share.v2:${Date.now()}:${crypto.randomUUID()}`
          }
        },
        { actorId: TEAM_ID, callerRpc: vi.fn(), serviceRpc: vi.fn(), shareMaterial }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(shareMaterial).not.toHaveBeenCalled();
  }
);
it('refuses an unversioned key on a modern mutation rather than using the old writer', async () => {
  const shareMaterial = vi.fn();
  await expect(
    executeLibraryOpsCommand(
      {
        action: 'share_copy',
        request: {
          teamId: TEAM_ID,
          materialId: MATERIAL_ID,
          allowIfRestricted: true,
          rememberChoice: false,
          expectedActorId: ACTOR_ID,
          expectedShareVersion: null,
          idempotencyKey: 'legacy-share-12345678'
        }
      },
      { actorId: ACTOR_ID, callerRpc: vi.fn(), serviceRpc: vi.fn(), shareMaterial }
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(shareMaterial).not.toHaveBeenCalled();
});
const modernLink = {
  state: 'ready',
  url: 'https://docs.google.com/spreadsheets/d/fixture/edit',
  public: false,
  permissionChanged: false,
  canShare: true,
  sharing: 'unchanged',
  linkProtocol: 2,
  serverNow: '2026-11-06T12:00:00.000Z',
  shareVersion: null
};
it('distinguishes unverified visibility from a known restricted URL without coercion', () => {
  expect(
    parseLibraryShareCopyResult({
      ...modernLink,
      public: null,
      visibilityCode: 'DRIVE_UNAVAILABLE'
    })
  ).toMatchObject({ public: null, permissionChanged: false, visibilityCode: 'DRIVE_UNAVAILABLE' });
  expect(parseLibraryShareCopyResult({ ...modernLink, public: false })).toMatchObject({
    public: false
  });
  expect(
    parseLibraryShareCopyResult({
      ...modernLink,
      public: true,
      permissionChanged: null,
      sharing: 'confirmed'
    })
  ).toMatchObject({ public: true, permissionChanged: null });
});
it.each([
  { public: 'false' },
  { permissionChanged: 'false' },
  { public: null },
  { linkProtocol: 3 },
  { serverNow: 'bad-date' },
  { shareVersion: 5 },
  { pendingCommandId: 'bad-id' },
  { preferenceSaved: false, preferenceCode: 'user-provided-message' },
  { preferenceSaved: true, preferenceCode: 'PERMISSION_DENIED' },
  { url: 'https://docs.google.com.evil.invalid/x' },
  {
    sharing: {
      toString() {
        throw new Error('must not coerce');
      }
    }
  }
])('refuses malformed link evidence %j without executing coercion', patch => {
  expect(parseLibraryShareCopyResult({ ...modernLink, ...patch })).toBeNull();
});
it('drops unrelated provider payload fields at the shared boundary', () => {
  const parsed = parseLibraryShareCopyResult({
    ...modernLink,
    providerPayload: { secret: 'synthetic' },
    rawName: 'Synthetic name'
  });
  expect(parsed).toEqual(modernLink);
});
