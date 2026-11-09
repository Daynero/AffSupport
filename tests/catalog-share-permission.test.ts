import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { ensureAnyoneReader } from '../supabase/functions/_shared/link-sharing';

it('creates public-link permission using the supported anyone request contract', async () => {
  let granted = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      // The official API only permits sendNotificationEmail for user/group grants.
      if (url.searchParams.has('sendNotificationEmail'))
        return Response.json({ error: { code: 400 } }, { status: 400 });
      expect(JSON.parse(String(init.body))).toEqual({
        type: 'anyone',
        role: 'reader',
        allowFileDiscovery: false
      });
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      granted = true;
      return Response.json({ id: 'public-grant', type: 'anyone', role: 'reader' });
    }
    return Response.json({
      permissions: granted ? [{ id: 'public-grant', type: 'anyone', role: 'reader' }] : []
    });
  });
  const drive = new GoogleDriveClient('synthetic-access-token', fetcher);
  await expect(ensureAnyoneReader(drive, 'catalog')).resolves.toEqual({ added: true });
  // A lost success reply/retry observes the permission; it does not create another.
  await expect(ensureAnyoneReader(drive, 'catalog')).resolves.toEqual({ added: false });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
