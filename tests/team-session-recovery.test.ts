import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const auth = { refreshSession: vi.fn() };
const rpc = vi.fn();

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
      data: { session: { access_token: 'new' } },
      error: null
    });
    rpc.mockResolvedValueOnce(rejected('PGRST301')).mockResolvedValueOnce(ok);

    const result = await withFreshSession(() => rpc('list_team_folder_tree', { p_team: 't' }));

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

    const result = await withFreshSession(() => rpc('list_team_folder_tree', { p_team: 't' }));

    // The original refusal is what the caller sees: one attempt, one refresh,
    // and an honest failure rather than a spin.
    expect(result).toMatchObject({ error: { code: 'PGRST303' } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('leaves a successful call completely alone', async () => {
    rpc.mockResolvedValue(ok);

    expect(await withFreshSession(() => rpc('list_team_folder_tree', { p_team: 't' }))).toEqual(ok);
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ordinary application error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'NOT_A_MEMBER' } });

    await withFreshSession(() => rpc('list_team_folder_tree', { p_team: 't' }));

    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
