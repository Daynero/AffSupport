import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A team screen that outlives its access token.
 *
 * PostgREST refuses an expired or clock-skewed JWT with `PGRST301`/`PGRST303`
 * and no HTTP status. Every team read used to treat that as final: the explorer
 * showed "could not read the space, try again in a minute", and trying again a
 * minute later did exactly the same thing, because nothing refreshed the token.
 *
 * The session is the one thing the browser can repair by itself, so it does.
 */

const ownerSession = {
  access_token: 'old',
  refresh_token: 'stable-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  user: {
    id: 'actor-a',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-11-03T00:00:00Z'
  }
};
const auth = { refreshSession: vi.fn(), getSession: vi.fn() };
const rpc = vi.fn();
// A PostgREST builder re-executes the same HTTP request when awaited again.
const request = (...args: unknown[]) =>
  Object.assign(rpc(...args), {
    setHeader: vi.fn(() => request(...args))
  });

vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    value: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'key' }
  }
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth, rpc })
}));

const { withFreshSession, isRejectedApiToken } = await import('../apps/web/src/lib/supabase');

const rejected = (code: string) => ({ data: null, error: { code, message: 'JWT rejected' } });
const ok = { data: [{ id: 'folder-1' }], error: null };

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  auth.getSession.mockReset().mockResolvedValue({ data: { session: ownerSession }, error: null });
  auth.refreshSession.mockReset();
  rpc.mockReset();
});

describe('recovering a rejected access token', () => {
  it('recognises the rejections PostgREST sends without an HTTP status', () => {
    expect(isRejectedApiToken({ code: 'PGRST301' })).toBe(true);
    expect(isRejectedApiToken({ code: 'PGRST303' })).toBe(true);
    expect(isRejectedApiToken({ status: 401 })).toBe(true);
    // A real application error must not be mistaken for an expired session.
    expect(isRejectedApiToken({ code: 'FOLDER_NOT_FOUND' })).toBe(false);
    expect(isRejectedApiToken(null)).toBe(false);
  });

  it('refreshes once and retries, so the second attempt is the one that answers', async () => {
    auth.refreshSession.mockResolvedValue({
      data: { session: { ...ownerSession, access_token: 'new' } },
      error: null
    });
    rpc.mockResolvedValueOnce(rejected('PGRST301')).mockResolvedValueOnce(ok);

    const result = await withFreshSession(() => request('list_team_folder_tree', { p_team: 't' }));

    expect(result).toEqual(ok);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('never loops on a session that is genuinely gone', async () => {
    auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'no session' }
    });
    rpc.mockResolvedValue(rejected('PGRST303'));

    const result = await withFreshSession(() => request('list_team_folder_tree', { p_team: 't' }));

    // The original refusal is what the caller sees: one attempt, one refresh,
    // and an honest failure rather than a spin.
    expect(result).toMatchObject({ error: { code: 'PGRST303' } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('leaves a successful call completely alone', async () => {
    rpc.mockResolvedValue(ok);

    expect(await withFreshSession(() => request('list_team_folder_tree', { p_team: 't' }))).toEqual(
      ok
    );
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ordinary application error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'NOT_A_MEMBER' } });

    await withFreshSession(() => request('list_team_folder_tree', { p_team: 't' }));

    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => vi.unstubAllGlobals());
it('does not replay a rejected request after another actor begins signing in', async () => {
  let resolve!: (value: ReturnType<typeof rejected>) => void;
  rpc.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  auth.refreshSession.mockResolvedValue({
    data: { session: { ...ownerSession, access_token: 'replacement-actor' } },
    error: null
  });
  const pending = withFreshSession(() => request('change_account_note'));
  await Promise.resolve();
  localStorage.setItem(
    'soty.auth.session-intent.v1:https://example.supabase.co',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  resolve(rejected('PGRST301'));
  expect(await pending).toMatchObject({ error: { code: 'PGRST301' } });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(auth.refreshSession).not.toHaveBeenCalled();
});
it('does not replay a request canceled while token refresh was awaiting', async () => {
  let resolve!: (value: unknown) => void;
  auth.refreshSession.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  rpc.mockResolvedValueOnce(rejected('PGRST301')).mockResolvedValueOnce(ok);
  const controller = new AbortController();
  const pending = withFreshSession(() => request('change_account_note'), {
    signal: controller.signal
  });
  await vi.waitFor(() => expect(auth.refreshSession).toHaveBeenCalledTimes(1));
  controller.abort();
  resolve({ data: { session: { ...ownerSession, access_token: 'new' } }, error: null });
  expect(await pending).toMatchObject({ error: { code: 'PGRST301' } });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('does not replay after the login intent changes during refresh', async () => {
  let resolve!: (value: unknown) => void;
  auth.refreshSession.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  rpc.mockResolvedValueOnce(rejected('PGRST301')).mockResolvedValueOnce(ok);
  const pending = withFreshSession(() => request('change_account_note'));
  await vi.waitFor(() => expect(auth.refreshSession).toHaveBeenCalledTimes(1));
  localStorage.setItem(
    'soty.auth.session-intent.v1:https://example.supabase.co',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
  resolve({ data: { session: { ...ownerSession, access_token: 'replacement' } }, error: null });
  expect(await pending).toMatchObject({ error: { code: 'PGRST301' } });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('does not retry a request captured during an unfinished interactive login', async () => {
  localStorage.setItem(
    'soty.auth.session-intent.v1:https://example.supabase.co',
    'pending:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  rpc.mockResolvedValueOnce(rejected('PGRST301')).mockResolvedValueOnce(ok);
  auth.refreshSession.mockResolvedValue({
    data: { session: { ...ownerSession, access_token: 'replacement' } },
    error: null
  });
  expect(await withFreshSession(() => request('change_account_note'))).toMatchObject({
    error: { code: 'PGRST301' }
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(auth.refreshSession).not.toHaveBeenCalled();
});

it('does not replay an opaque native Promise whose credentials cannot be bound', async () => {
  const run = vi.fn(async () => rejected('PGRST301'));
  expect(await withFreshSession(run)).toMatchObject({ error: { code: 'PGRST301' } });
  expect(run).toHaveBeenCalledTimes(1);
  expect(auth.refreshSession).not.toHaveBeenCalled();
});
