// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-user-jwt' } } }) }
  }),
  withFreshSession: async (run: () => Promise<unknown>) => run()
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'test-publishable-key' }
  }
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('downloads the binary with user auth and revokes the object URL', async () => {
  vi.useFakeTimers();
  const create = vi.fn().mockReturnValue('blob:finance-test');
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0x50, 0x4b, 3, 4, 0]), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    })
  );
  vi.stubGlobal('fetch', fetcher);
  await teamFinanceApi.export('team', '2026-09-01', '2026-09-30', 'UTC');
  expect(fetcher).toHaveBeenCalledWith(
    'http://127.0.0.1:54321/functions/v1/team-finance-export',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-user-jwt' })
    })
  );
  expect(create).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1001);
  expect(revoke).toHaveBeenCalledWith('blob:finance-test');
});
it('never downloads an error document or a response with the wrong MIME', async () => {
  const create = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ok: false, error: { code: 'PERMISSION_DENIED' } }, { status: 403 })
      )
  );
  await expect(teamFinanceApi.export('team', '2026-09-01', '2026-09-30', 'UTC')).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  expect(create).not.toHaveBeenCalled();
});
