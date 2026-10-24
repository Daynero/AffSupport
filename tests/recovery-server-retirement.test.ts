// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: fake.session } })
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'synthetic-public-key' }
  }
}));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const INSTALL = '33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fake.session.mockReset();
  fake.fetch.mockReset();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const hint = await import('../apps/web/src/api/recovery-installation');
  hint.rememberRecoveryInstallation(INSTALL);
  return import('../apps/web/src/api/recovery-server-retirement');
}
it('uses only the remembered installation and captured actor session for server cleanup', async () => {
  const api = await setup();
  fake.session.mockResolvedValue({
    data: { session: { user: { id: A }, access_token: 'synthetic-a' } },
    error: null
  });
  fake.fetch.mockImplementation(async (_url, init) => {
    fake.session.mockResolvedValue({
      data: { session: { user: { id: B }, access_token: 'synthetic-b' } },
      error: null
    });
    expect(init.headers.authorization).toBe('Bearer synthetic-a');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ p_installation: INSTALL, p_attempt: expect.any(String) });
    return new Response(
      JSON.stringify({ attemptId: body.p_attempt, state: 'server_confirmed', retiredCount: 1 })
    );
  });
  expect(await api.retireServerRecovery(A)).toBe('confirmed');
  expect(fake.fetch).toHaveBeenCalledOnce();
});
it('does not use a different browser actor to execute a stale logout', async () => {
  const api = await setup();
  fake.session.mockResolvedValue({
    data: { session: { user: { id: B }, access_token: 'synthetic-b' } },
    error: null
  });
  expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  expect(fake.fetch).not.toHaveBeenCalled();
});
it('does not guess an installation or broaden to all devices when none is known', async () => {
  const api = await import('../apps/web/src/api/recovery-server-retirement');
  expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  expect(fake.session).not.toHaveBeenCalled();
  expect(fake.fetch).not.toHaveBeenCalled();
});
it.each([new Response('{}'), new Response('0', { status: 403 })])(
  'does not treat an invalid or refused receipt as acknowledgement',
  async response => {
    const api = await setup();
    fake.session.mockResolvedValue({
      data: { session: { user: { id: A }, access_token: 'synthetic-a' } },
      error: null
    });
    fake.fetch.mockResolvedValue(response);
    expect(await api.retireServerRecovery(A)).toBe('unconfirmed');
  }
);
it('bounds session lookup as well as the server request when auth cannot settle', async () => {
  vi.useFakeTimers();
  try {
    const api = await setup();
    fake.session.mockImplementation(() => new Promise(() => {}));
    const result = api.retireServerRecovery(A);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toBe('unconfirmed');
    expect(fake.fetch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
