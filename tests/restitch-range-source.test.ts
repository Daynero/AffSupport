import { expect, it, vi } from 'vitest';
import { readRestitchSelectionRange } from '../supabase/functions/drive-ops/restitch-range-reader';
import { createRestitchRangeOpener } from '../supabase/functions/drive-ops/restitch-range-source';
const id = (n: number) => 'b1570000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture(changes: Record<string, unknown> = {}) {
  let time = 0;
  const source = {
    fileId: 'synthetic-image',
    resourceKey: null,
    parentFolderId: 'root',
    rootFolderId: 'root',
    sizeBytes: 4,
    mimeType: 'image/png' as const,
    checksum: 'a'.repeat(32)
  };
  const credentials = {
    credential: {
      credentialId: id(3),
      connectedBy: id(4),
      googlePermissionId: 'synthetic-permission',
      googleAccountEmail: 'fixture@selection.invalid',
      scope: 'https://www.googleapis.com/auth/drive.file',
      refreshToken: 'SYNTHETIC_REFRESH_TOKEN'
    },
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    oauthMode: 'testing',
    productionSignals: { siteUrl: 'http://127.0.0.1:5175', requestOrigin: 'http://127.0.0.1:5175' }
  };
  const reserve = vi.fn(async () => ({
    kind: 'dispatch' as const,
    reservation: {
      requestId: id(1),
      candidateVersionId: id(2),
      acquisition: 0,
      offset: 0,
      bytesReserved: 4,
      ioMsReserved: 120000,
      retry: false,
      settlement: null
    }
  }));
  const settle = vi.fn(async () => {});
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(reserve).toHaveBeenCalledOnce();
    time += 5;
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com')
      return new Response(
        JSON.stringify({ access_token: 'SYNTHETIC_ACCESS_TOKEN_047', expires_in: 3600 })
      );
    if (url.searchParams.get('alt') === 'media') {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer SYNTHETIC_ACCESS_TOKEN_047',
        range: 'bytes=0-3'
      });
      return new Response('ABCD', {
        status: 206,
        headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' }
      });
    }
    return new Response(
      JSON.stringify({
        id: 'synthetic-image',
        name: 'Synthetic.png',
        mimeType: 'image/png',
        size: '4',
        version: '999',
        md5Checksum: 'a'.repeat(32),
        parents: ['root'],
        trashed: false,
        capabilities: { canDownload: true },
        ...changes
      })
    );
  });
  const open = createRestitchRangeOpener(source, credentials);
  const input = {
    store: { reserve, settle },
    versionId: id(2),
    requestId: id(1),
    acquisition: 0,
    offset: 0,
    sourceFileId: source.fileId,
    sourceBytes: 4,
    mimeType: source.mimeType
  };
  return {
    source,
    credentials,
    reserve,
    settle,
    fetcher,
    input,
    deps: { open, fetch: fetcher, now: () => time }
  };
}
it('uses the frozen source through the real token and Drive clients, allowing metadata-only changes', async () => {
  const f = fixture();
  // Resolver output cannot be swapped after the opener has accepted its snapshot.
  f.source.fileId = 'replacement';
  f.source.checksum = 'b'.repeat(32);
  f.credentials.credential.refreshToken = 'REPLACEMENT_PRIVATE_TOKEN';
  const result = await readRestitchSelectionRange(f.input, f.deps);
  expect(await result.text()).toBe('ABCD');
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(String(f.fetcher.mock.calls[0]?.[1]?.body)).toContain('SYNTHETIC_REFRESH_TOKEN');
  expect(f.settle).toHaveBeenCalledWith(id(1), { bytes: 4, ioMs: 15, complete: true });
});
it.each([
  [{ md5Checksum: 'b'.repeat(32) }, 'SOURCE_CHANGED'],
  [{ size: '5' }, 'SOURCE_CHANGED'],
  [{ mimeType: 'image/jpeg' }, 'SOURCE_CHANGED'],
  [{ trashed: true }, 'PERMISSION_DENIED'],
  [{ parents: ['elsewhere'] }, 'PERMISSION_DENIED'],
  [{ capabilities: { canDownload: false } }, 'PERMISSION_DENIED']
])('refuses changed or inaccessible images before media I/O: %j', async (change, code) => {
  const f = fixture(change);
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({ code });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.settle).toHaveBeenCalledWith(id(1), { bytes: 0, ioMs: 10, complete: false });
});
it('does not contact OAuth or Drive without a new acknowledged reservation', async () => {
  const f = fixture();
  f.reserve.mockRejectedValue(new Error('SYNTHETIC_LOST_ACK'));
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toThrow('SYNTHETIC_LOST_ACK');
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.settle).not.toHaveBeenCalled();
});
