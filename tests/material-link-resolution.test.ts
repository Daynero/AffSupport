import { expect, it, vi } from 'vitest';
import {
  resolveMaterialShare,
  type ShareResolutionDependencies
} from '../supabase/functions/library-ops/share-resolution';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
const url = 'https://docs.google.com/spreadsheets/d/fixture/edit';
const input = {
  fileId: 'fixture',
  webViewLink: url,
  canShare: true,
  shareVersion: null,
  allowIfRestricted: false,
  rememberChoice: false
};
function dependencies(): ShareResolutionDependencies {
  return {
    listAnyonePermissions: vi.fn().mockResolvedValue([]),
    authorizeWrite: vi.fn(),
    reserve: vi.fn().mockResolvedValue({
      intentId: '47000000-0000-4000-8000-000000000001',
      writeAllowed: true,
      state: 'write_started',
      attribution: 'unchanged',
      shareVersion: '47000000-0000-4000-8000-000000000002'
    }),
    createReader: vi.fn().mockResolvedValue({ id: 'permission' }),
    recordAcknowledgement: vi.fn(),
    confirmPublic: vi.fn(),
    remember: vi.fn(),
    observePublic: vi.fn(),
    pending: vi.fn().mockResolvedValue({ pending: false, shareVersion: null }),
    now: () => '2026-11-06T12:00:00.000Z'
  };
}
it('retrieves a restricted provider URL without requesting edit, preference or permission changes', async () => {
  const deps = dependencies();
  expect(await resolveMaterialShare(input, deps)).toMatchObject({
    state: 'confirmation_required',
    url,
    public: false,
    canShare: true
  });
  expect(deps.reserve).not.toHaveBeenCalled();
  expect(deps.authorizeWrite).not.toHaveBeenCalled();
  expect(deps.createReader).not.toHaveBeenCalled();
  expect(deps.remember).not.toHaveBeenCalled();
});
it('preserves the verified URL when listing permissions is unavailable', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions).mockRejectedValue(
    new TeamFunctionError('PERMISSION_DENIED')
  );
  expect(await resolveMaterialShare(input, deps)).toMatchObject({
    state: 'ready',
    url,
    public: null,
    visibilityCode: 'PERMISSION_DENIED',
    permissionChanged: false
  });
  expect(deps.reserve).not.toHaveBeenCalled();
  expect(deps.createReader).not.toHaveBeenCalled();
});
it.each(['reader', 'commenter', 'writer'])(
  'preserves an existing public %s and remains usable by a viewer',
  async role => {
    const deps = dependencies();
    vi.mocked(deps.listAnyonePermissions).mockResolvedValue([{ id: 'existing', role }]);
    vi.mocked(deps.authorizeWrite).mockRejectedValue(new TeamFunctionError('PERMISSION_DENIED'));
    expect(await resolveMaterialShare({ ...input, canShare: false }, deps)).toMatchObject({
      state: 'ready',
      public: true,
      permissionChanged: false
    });
    expect(deps.authorizeWrite).not.toHaveBeenCalled();
    expect(deps.createReader).not.toHaveBeenCalled();
  }
);
it('recovers an existing per-file hold after reload without offering another permission write', async () => {
  const deps = dependencies();
  vi.mocked(deps.pending).mockResolvedValue({
    pending: true,
    shareVersion: null,
    commandId: '47000000-0000-4000-8000-000000000009'
  });
  expect(await resolveMaterialShare(input, deps)).toMatchObject({
    state: 'ready',
    public: false,
    canShare: false,
    sharing: 'uncertain',
    pendingCommandId: '47000000-0000-4000-8000-000000000009'
  });
  expect(deps.reserve).not.toHaveBeenCalled();
  expect(deps.createReader).not.toHaveBeenCalled();
});
it('consumes one durable permit and verifies the supported real Google Drive permission request', async () => {
  let granted = false;
  let posts = 0;
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(request));
    if (init?.method === 'POST') {
      posts++;
      expect(requestUrl.searchParams.has('sendNotificationEmail')).toBe(false);
      expect(JSON.parse(String(init.body))).toEqual({
        type: 'anyone',
        role: 'reader',
        allowFileDiscovery: false
      });
      granted = true;
      return Response.json({ id: 'permission', type: 'anyone', role: 'reader' });
    }
    return Response.json({
      permissions: granted ? [{ id: 'permission', type: 'anyone', role: 'reader' }] : []
    });
  });
  const drive = new GoogleDriveClient('synthetic-access-token', fetcher);
  const deps = dependencies();
  deps.listAnyonePermissions = id => drive.listAnyonePermissions(id);
  deps.createReader = id => drive.createAnyoneReaderPermission(id);
  expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
    public: true,
    permissionChanged: true,
    sharing: 'confirmed'
  });
  expect(posts).toBe(1);
  expect(deps.recordAcknowledgement).toHaveBeenCalledWith(expect.any(String), 'permission');
  expect(deps.confirmPublic).toHaveBeenCalledWith(expect.any(String), 'permission', false);
  expect(deps.remember).not.toHaveBeenCalled();
});
it('does not grant after public access appears between inspection and the reserved write', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions)
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ id: 'other', role: 'writer' }]);
  expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
    public: true,
    permissionChanged: false
  });
  expect(deps.createReader).not.toHaveBeenCalled();
  expect(deps.confirmPublic).toHaveBeenCalledWith(expect.any(String), null, true);
});
it('reconciles a lost provider reply without inventing which writer created the observed permission', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ id: 'observed', role: 'reader' }]);
  vi.mocked(deps.createReader).mockRejectedValue(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
    url,
    public: true,
    permissionChanged: null,
    sharing: 'confirmed'
  });
  expect(deps.createReader).toHaveBeenCalledTimes(1);
  expect(deps.confirmPublic).toHaveBeenCalledWith(expect.any(String), null, false);
});
it.each(['write_started', 'blocked'] as const)(
  'never recreates permission under a %s replay',
  async state => {
    const deps = dependencies();
    vi.mocked(deps.reserve).mockResolvedValue({
      intentId: 'existing',
      writeAllowed: false,
      state,
      attribution: 'unknown',
      shareVersion: null
    });
    expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
      url,
      public: false,
      sharing: 'uncertain'
    });
    expect(deps.createReader).not.toHaveBeenCalled();
    expect(deps.remember).not.toHaveBeenCalled();
  }
);
it('does not regrant a completed key after access was changed outside Soty', async () => {
  const deps = dependencies();
  vi.mocked(deps.reserve).mockResolvedValue({
    intentId: 'existing',
    writeAllowed: false,
    state: 'confirmed',
    attribution: 'acknowledged',
    shareVersion: null
  });
  expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
    state: 'confirmation_required',
    public: false,
    sharing: 'unchanged'
  });
  expect(deps.createReader).not.toHaveBeenCalled();
});
it('retains URL and acknowledged create when final visibility cannot be read', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockRejectedValue(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  expect(await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps)).toMatchObject({
    url,
    public: null,
    permissionChanged: true,
    sharing: 'uncertain',
    visibilityCode: 'DRIVE_UNAVAILABLE'
  });
  expect(deps.createReader).toHaveBeenCalledTimes(1);
  expect(deps.remember).not.toHaveBeenCalled();
});
it('keeps public URL available when preference saving fails after confirmed permission', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ id: 'permission', role: 'reader' }]);
  vi.mocked(deps.remember).mockRejectedValue(new TeamFunctionError('RATE_LIMITED'));
  expect(
    await resolveMaterialShare({ ...input, allowIfRestricted: true, rememberChoice: true }, deps)
  ).toMatchObject({
    url,
    public: true,
    sharing: 'confirmed',
    preferenceSaved: false,
    preferenceCode: 'RATE_LIMITED'
  });
  expect(deps.createReader).toHaveBeenCalledTimes(1);
});
it.each([
  'https://docs.google.com.evil.invalid/x',
  'http://drive.google.com/file/d/x',
  'https://user:password@docs.google.com/x',
  'https://drive.google.com:444/x',
  'https://other.invalid/x'
])('rejects unsafe provider URL %s before permission calls', async webViewLink => {
  const deps = dependencies();
  await expect(resolveMaterialShare({ ...input, webViewLink }, deps)).rejects.toMatchObject({
    code: 'CATALOG_LINK_UNAVAILABLE'
  });
  expect(deps.listAnyonePermissions).not.toHaveBeenCalled();
  expect(deps.createReader).not.toHaveBeenCalled();
});

it.each(['', 'x'.repeat(201), 'bad\npermission'])(
  'refuses malformed acknowledged permission identity %j',
  async id => {
    const drive = new GoogleDriveClient('synthetic-access-token', async () =>
      Response.json({ id, type: 'anyone', role: 'reader' })
    );
    await expect(drive.createAnyoneReaderPermission('fixture')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  }
);
it('retains a proven public URL while exposing an unrecorded server confirmation', async () => {
  const deps = dependencies();
  vi.mocked(deps.listAnyonePermissions).mockResolvedValue([{ id: 'existing', role: 'reader' }]);
  vi.mocked(deps.observePublic).mockRejectedValue(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  expect(await resolveMaterialShare(input, deps)).toMatchObject({
    url,
    public: true,
    permissionChanged: false,
    sharing: 'uncertain',
    visibilityCode: 'DRIVE_UNAVAILABLE'
  });
  expect(deps.reserve).not.toHaveBeenCalled();
  expect(deps.createReader).not.toHaveBeenCalled();
});
it('revalidates edit access after the reserved provider inspection before dispatching permission creation', async () => {
  const deps = dependencies();
  vi.mocked(deps.authorizeWrite)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new TeamFunctionError('PERMISSION_DENIED'));
  const result = await resolveMaterialShare({ ...input, allowIfRestricted: true }, deps);
  expect(deps.createReader).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    public: false,
    sharing: 'uncertain',
    visibilityCode: 'PERMISSION_DENIED'
  });
});
