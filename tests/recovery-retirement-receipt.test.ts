// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
const ACTOR = '11111111-1111-4111-8111-111111111111';
const INSTALLATION = '33333333-3333-4333-8333-333333333333';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  fake.session.mockReset();
  fake.fetch.mockReset();
  fake.session.mockResolvedValue({
    data: { session: { user: { id: ACTOR }, access_token: 'synthetic-actor-session' } },
    error: null
  });
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const hint = await import('../apps/web/src/api/recovery-installation');
  hint.rememberRecoveryInstallation(INSTALLATION);
  return import('../apps/web/src/api/recovery-server-retirement');
}

it('requires a correlated authoritative server receipt while preserving the existing outcome API', async () => {
  const api = await setup();
  let attempt: string | undefined;
  fake.fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.p_installation).toBe(INSTALLATION);
    expect(body.p_attempt).toMatch(UUID);
    expect(init.headers.authorization).toBe('Bearer synthetic-actor-session');
    attempt = body.p_attempt;
    return new Response(
      JSON.stringify({ attemptId: attempt, state: 'server_confirmed', retiredCount: 1 })
    );
  });
  expect(await api.retireServerRecovery(ACTOR)).toBe('confirmed');
  expect(fake.fetch).toHaveBeenCalledOnce();
  expect(fake.fetch.mock.calls[0]![0]).toBe(
    'http://127.0.0.1:54321/rest/v1/rpc/retire_team_recovery_installation_observed'
  );
  expect(attempt).toMatch(UUID);
});

it('never treats an uncorrelated receipt as confirmation', async () => {
  const api = await setup();
  fake.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        attemptId: '44444444-4444-4444-8444-444444444444',
        state: 'server_confirmed',
        retiredCount: 1
      })
    )
  );
  expect(await api.retireServerRecovery(ACTOR)).toBe('unconfirmed');
  expect(JSON.parse(fake.fetch.mock.calls[0]![1].body).p_attempt).toMatch(UUID);
});

it('does not confuse a legacy numeric response with a persisted attempt receipt', async () => {
  const api = await setup();
  fake.fetch.mockResolvedValue(new Response('1'));
  expect(await api.retireServerRecovery(ACTOR)).toBe('unconfirmed');
});
