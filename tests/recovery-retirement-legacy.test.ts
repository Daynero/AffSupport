// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn(), track: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: fake.session } })
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'synthetic-key' }
  }
}));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { trackForActor: fake.track } }));
const A = 'e1670000-0000-4000-8000-000000000001';
const INSTALL = 'e1670000-0000-4000-8000-000000000003';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fake.session.mockReset();
  fake.fetch.mockReset();
  fake.track.mockReset();
  fake.session.mockResolvedValue({
    data: { session: { user: { id: A }, access_token: 'synthetic-a' } },
    error: null
  });
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function setup() {
  (await import('../apps/web/src/api/recovery-installation')).rememberRecoveryInstallation(INSTALL);
  return import('../apps/web/src/api/recovery-server-retirement');
}
it('preserves old-backend scoped revocation while leaving a persisted attempt receipt unconfirmed', async () => {
  const api = await setup();
  fake.fetch
    .mockImplementationOnce(async () => {
      fake.session.mockResolvedValue({
        data: {
          session: {
            user: { id: 'e1670000-0000-4000-8000-000000000002' },
            access_token: 'synthetic-b'
          }
        },
        error: null
      });
      return new Response(JSON.stringify({ code: 'PGRST202' }), { status: 404 });
    })
    .mockResolvedValueOnce(new Response('1'));
  expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  expect(fake.fetch.mock.calls.map(call => call[0])).toEqual([
    'http://127.0.0.1:54321/rest/v1/rpc/retire_team_recovery_installation_observed',
    'http://127.0.0.1:54321/rest/v1/rpc/retire_team_recovery_installation'
  ]);
  expect(JSON.parse(fake.fetch.mock.calls[1]![1].body)).toEqual({ p_installation: INSTALL });
  expect(fake.fetch.mock.calls[1]![1].headers.authorization).toBe('Bearer synthetic-a');
  expect(fake.session).toHaveBeenCalledOnce();
  expect(fake.track).toHaveBeenLastCalledWith(
    A,
    'operation_failed',
    expect.objectContaining({ error_category: 'legacy_contract' })
  );
});
it('does not replay retirement after a refused observed RPC with another error code', async () => {
  const api = await setup();
  fake.fetch.mockResolvedValue(
    new Response(JSON.stringify({ code: 'PERMISSION_DENIED' }), { status: 403 })
  );
  expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  expect(fake.fetch).toHaveBeenCalledOnce();
});
it('does not replay an observed request whose outcome was lost', async () => {
  const api = await setup();
  fake.fetch.mockRejectedValue(new Error('synthetic-network-loss'));
  expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  expect(fake.fetch).toHaveBeenCalledOnce();
});

it('shares the original deadline with the legacy request and ignores its late acknowledgement', async () => {
  vi.useFakeTimers();
  const api = await setup();
  let resolveLegacy!: (response: Response) => void;
  fake.fetch
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PGRST202' }), { status: 404 }))
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveLegacy = resolve;
        })
    );
  const pending = api.retireServerRecovery(A);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await pending).toBe('unconfirmed');
  expect(fake.fetch.mock.calls[1]![1].signal).toBe(fake.fetch.mock.calls[0]![1].signal);
  expect(fake.fetch.mock.calls[1]![1].signal.aborted).toBe(true);
  resolveLegacy(new Response('1'));
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.track.mock.calls.map(call => call[1])).toEqual([
    'operation_started',
    'operation_failed'
  ]);
  expect(fake.track).toHaveBeenLastCalledWith(
    A,
    'operation_failed',
    expect.objectContaining({ error_category: 'timeout' })
  );
});
