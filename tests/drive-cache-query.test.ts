import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';

it('limits thumbnail discovery to the same parent and exact escaped app marker', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ files: [] })));
  const client = new GoogleDriveClient('test-access-token', fetcher);
  await client.listChildren({
    parentId: 'cache-shard',
    pageToken: 'page-2',
    appProperty: { key: "soty.'thumbnail", value: "a\\b'c" }
  });
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get('q')).toBe(
    "'cache-shard' in parents and trashed = false and appProperties has { key='soty.\\'thumbnail' and value='a\\\\b\\'c' }"
  );
  expect(url.searchParams.get('pageToken')).toBe('page-2');
  expect(url.searchParams.get('fields')).toContain('incompleteSearch');
});
