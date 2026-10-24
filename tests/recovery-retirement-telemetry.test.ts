// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn(), track: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: fake.session } })
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'synthetic-public-key' }
  }
}));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { trackForActor: fake.track } }));
const ACTOR = 'e1670000-0000-4000-8000-000000000001';
const INSTALLATION = 'e1670000-0000-4000-8000-000000000003';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fake.session.mockReset();
  fake.fetch.mockReset();
  fake.track.mockReset();
  fake.session.mockResolvedValue({
    data: { session: { user: { id: ACTOR }, access_token: 'synthetic-session-secret' } },
    error: null
  });
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function setup(withHint = true) {
  if (withHint)
    (await import('../apps/web/src/api/recovery-installation')).rememberRecoveryInstallation(
      INSTALLATION
    );
  return import('../apps/web/src/api/recovery-server-retirement');
}
it('correlates attempted and acknowledged stages with the exact server receipt attempt', async () => {
  const api = await setup();
  let attempt: string | undefined;
  fake.fetch.mockImplementation(async (_url, init) => {
    attempt = JSON.parse(init.body).p_attempt;
    return new Response(
      JSON.stringify({ attemptId: attempt, state: 'server_confirmed', retiredCount: 1 })
    );
  });
  expect(await api.retireServerRecovery(ACTOR)).toBe('confirmed');
  expect(fake.track.mock.calls.map(call => call[1])).toEqual([
    'operation_started',
    'operation_completed'
  ]);
  for (const call of fake.track.mock.calls)
    expect(call).toEqual([
      ACTOR,
      expect.any(String),
      expect.objectContaining({
        flow_id: attempt,
        attempt_id: attempt,
        flow_step: 'recovery_retirement_ack'
      })
    ]);
  expect(JSON.stringify(fake.track.mock.calls)).not.toContain('synthetic-session-secret');
});
it('records missing scope as unconfirmed without broadening to all installations', async () => {
  const api = await setup(false);
  expect(await api.retireServerRecovery(ACTOR)).toBe('unconfirmed');
  expect(fake.fetch).not.toHaveBeenCalled();
  expect(fake.track).toHaveBeenLastCalledWith(
    ACTOR,
    'operation_failed',
    expect.objectContaining({
      error_category: 'missing_scope',
      error_code: 'RECOVERY_RETIREMENT_UNCONFIRMED'
    })
  );
});
it('records transport loss as an acknowledgement gap without collecting exception content', async () => {
  const api = await setup();
  fake.fetch.mockRejectedValue(new Error('/private/synthetic-path synthetic-session-secret'));
  expect(await api.retireServerRecovery(ACTOR)).toBe('unconfirmed');
  expect(fake.track).toHaveBeenLastCalledWith(
    ACTOR,
    'operation_failed',
    expect.objectContaining({
      error_category: 'network',
      error_code: 'RECOVERY_RETIREMENT_UNCONFIRMED'
    })
  );
  expect(JSON.stringify(fake.track.mock.calls)).not.toMatch(
    /synthetic-path|synthetic-session-secret/
  );
});
it('emits one timeout outcome and ignores a late session lookup', async () => {
  vi.useFakeTimers();
  const api = await setup();
  let resolve!: (value: unknown) => void;
  fake.session.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  const pending = api.retireServerRecovery(ACTOR);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await pending).toBe('unconfirmed');
  resolve({ data: { session: { user: { id: ACTOR }, access_token: 'late-secret' } }, error: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.fetch).not.toHaveBeenCalled();
  expect(fake.track.mock.calls.map(call => call[1])).toEqual([
    'operation_started',
    'operation_failed'
  ]);
  expect(fake.track).toHaveBeenLastCalledWith(
    ACTOR,
    'operation_failed',
    expect.objectContaining({ error_category: 'timeout' })
  );
});
