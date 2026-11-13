import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';

const file = {
  id: 'sheet-id',
  title: 'Old',
  etag: '"v1"',
  parents: [{ id: 'root' }],
  labels: { trashed: false },
  capabilities: { canRename: true }
};
it('reads the strong v2 ETag and sends one conditional title-only PATCH with the same deadline', async () => {
  const signal = AbortSignal.timeout(1000);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain('/drive/v2/files/sheet-id');
    expect(init?.signal).toBe(signal);
    if (init?.method === 'PATCH') {
      expect(new Headers(init.headers).get('if-match')).toBe('"v1"');
      expect(JSON.parse(String(init.body))).toEqual({ title: 'New' });
      return Response.json({ id: 'sheet-id', title: 'New' });
    }
    return Response.json(file);
  });
  const client = new GoogleDriveClient('synthetic-access-token', fetcher);
  expect(await client.getCatalogRenameFile('sheet-id', signal)).toMatchObject({
    name: 'Old',
    etag: '"v1"',
    canRename: true
  });
  await client.renameCatalogConditionally('sheet-id', '"v1"', 'New', signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([undefined, 'weak', 'W/"weak"', '"bad\r\nheader"'])(
  'rejects missing or unsafe provider ETag %s',
  async etag => {
    const client = new GoogleDriveClient('synthetic-access-token', async () =>
      Response.json({ ...file, etag })
    );
    await expect(
      client.getCatalogRenameFile('sheet-id', AbortSignal.timeout(1000))
    ).rejects.toThrow('INVALID_RESPONSE');
  }
);
it.each([412, 503])(
  'never automatically retries a conditional PATCH returning %s',
  async status => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: {} }, { status }));
    const client = new GoogleDriveClient('synthetic-access-token', fetcher);
    await expect(
      client.renameCatalogConditionally('sheet-id', '"v1"', 'New', AbortSignal.timeout(1000))
    ).rejects.toThrow(status === 412 ? 'SOURCE_CHANGED' : 'DRIVE_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledOnce();
  }
);
it('preserves the provider Retry-After floor without issuing an early read retry', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ error: {} }, { status: 429, headers: { 'retry-after': '3600' } })
  );
  const client = new GoogleDriveClient('synthetic-access-token', fetcher);
  await expect(
    client.getCatalogRenameFile('sheet-id', AbortSignal.timeout(1000))
  ).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterMs: 3_600_000 } });
  expect(fetcher).toHaveBeenCalledOnce();
});
