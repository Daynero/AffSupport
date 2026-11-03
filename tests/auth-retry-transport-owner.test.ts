import { type Session } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from './fixtures/catalog-sync';

vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'http://127.0.0.1:1', supabasePublishableKey: 'synthetic-public-key' }
  }
}));
const { requireSupabaseClient, withFreshSession } = await import('../apps/web/src/lib/supabase');
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps retry transport bound to the refreshed owner when SDK token acquisition races a new login', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  const authorizations: Array<string | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      return authorizations.length === 1
        ? Response.json(
            { code: 'PGRST301', message: 'synthetic expired credential' },
            { status: 401 }
          )
        : Response.json({ owner: 'transport-result' });
    })
  );
  const client = requireSupabaseClient();
  const session = (id: string): Session => ({
    access_token: `synthetic-${id}`,
    refresh_token: `refresh-${id}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-03T00:00:00Z'
    }
  });
  const a = session('actor-a'),
    b = session('actor-b');
  const retrySession = deferred<{ data: { session: Session }; error: null }>();
  const retryEntered = deferred<void>();
  vi.spyOn(client.auth, 'getSession')
    .mockResolvedValueOnce({ data: { session: a }, error: null })
    .mockResolvedValueOnce({ data: { session: a }, error: null })
    .mockImplementationOnce(() => {
      retryEntered.resolve();
      return retrySession.promise;
    });
  vi.spyOn(client.auth, 'refreshSession').mockResolvedValue({
    data: { session: a, user: a.user },
    error: null
  });
  const pending = withFreshSession(() => client.rpc('list_my_teams'));
  await retryEntered.promise;
  localStorage.setItem(
    'soty.auth.session-intent.v1:http://127.0.0.1:1',
    'pending:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  retrySession.resolve({ data: { session: b }, error: null });
  const result = await pending;
  expect(result.error?.code).toBe('PGRST301');
  await client.auth.stopAutoRefresh();
  expect(authorizations).toEqual(['Bearer synthetic-actor-a', 'Bearer synthetic-actor-a']);
});

it('preserves binary finance export recovery with an explicitly bound refreshed token', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  const authorizations: Array<string | null> = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return authorizations.length === 1
      ? Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
      : new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        });
  });
  vi.stubGlobal('fetch', fetcher);
  const click = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click }) });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-finance-export');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const client = requireSupabaseClient();
  const session = {
    access_token: 'old-owner-token',
    refresh_token: 'synthetic',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: 'actor-a',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-03T00:00:00Z'
    }
  } as Session;
  const getSession = vi
    .spyOn(client.auth, 'getSession')
    .mockResolvedValue({ data: { session }, error: null });
  vi.spyOn(client.auth, 'refreshSession').mockResolvedValue({
    data: { session: { ...session, access_token: 'fresh-owner-token' }, user: session.user },
    error: null
  });
  const { teamFinanceApi } = await import('../apps/web/src/api/team-finance');
  await teamFinanceApi.export('team', '2026-11-01', '2026-11-03', 'UTC');
  expect(authorizations).toEqual(['Bearer old-owner-token', 'Bearer fresh-owner-token']);
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(click).toHaveBeenCalledTimes(1);
});

it('does not issue another SDK HTTP request after cancellation during refresh', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  const fetcher = vi.fn(async () =>
    Response.json({ code: 'PGRST301', message: 'synthetic rejected credential' }, { status: 401 })
  );
  vi.stubGlobal('fetch', fetcher);
  const client = requireSupabaseClient();
  const session = {
    access_token: 'synthetic-owner',
    refresh_token: 'synthetic',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: 'actor-a',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-03T00:00:00Z'
    }
  } as Session;
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session }, error: null });
  const entered = deferred<void>();
  const refresh = deferred<Awaited<ReturnType<typeof client.auth.refreshSession>>>();
  vi.spyOn(client.auth, 'refreshSession').mockImplementation(() => {
    entered.resolve();
    return refresh.promise;
  });
  const controller = new AbortController();
  const pending = withFreshSession(() => client.rpc('list_my_teams'), {
    signal: controller.signal
  });
  await entered.promise;
  controller.abort();
  refresh.resolve({ data: { session, user: session.user }, error: null });
  expect((await pending).error?.code).toBe('PGRST301');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refuses replay when a legacy tab commits another session without changing its plain intent', async () => {
  const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  vi.stubGlobal('localStorage', {
    getItem: () => revision,
    setItem: () => {},
    removeItem: () => {}
  });
  const authorizations: Array<string | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return authorizations.length === 1
        ? Response.json(
            { code: 'PGRST301', message: 'synthetic rejected old session' },
            { status: 401 }
          )
        : Response.json({ owner: 'replacement-account' });
    })
  );
  const client = requireSupabaseClient();
  const a = {
    access_token: 'synthetic-actor-a',
    refresh_token: 'synthetic-refresh-a',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: 'actor-a',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-03T00:00:00Z'
    }
  } as Session;
  const b = {
    ...a,
    access_token: 'synthetic-actor-b',
    refresh_token: 'synthetic-refresh-b',
    user: { ...a.user, id: 'actor-b' }
  };
  vi.spyOn(client.auth, 'getSession').mockResolvedValue({ data: { session: a }, error: null });
  vi.spyOn(client.auth, 'refreshSession').mockResolvedValue({
    data: { session: b, user: b.user },
    error: null
  });
  const result = await withFreshSession(() => client.rpc('list_my_teams'));
  expect(result.error?.code).toBe('PGRST301');
  expect(authorizations).toEqual(['Bearer synthetic-actor-a']);
});
