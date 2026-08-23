import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ functions: { invoke } }),
  getSupabaseClient: () => ({ functions: { invoke } })
}));

const { invokeTeamFunction, TeamApiError } = await import('../apps/web/src/api/team');

const anything = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

afterEach(() => {
  invoke.mockReset();
});

/**
 * Mirrors what supabase-js hands back for a non-2xx edge response: the parsed
 * body is dropped, and the untouched Response is attached to the error.
 */
function httpFailure(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
  const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    name: 'FunctionsHttpError',
    context: response
  });
  return { data: null, error };
}

describe('team edge error transport', () => {
  it('keeps the error code a refused call answered with', async () => {
    // Every team refusal arrives as a real status plus an envelope. Reading only
    // `data` collapsed all of them into DRIVE_UNAVAILABLE, which named the wrong
    // cause and left the UI unable to say anything useful.
    invoke.mockResolvedValue(
      httpFailure(409, { ok: false, error: { code: 'ALREADY_INVITED', retryable: false } })
    );

    await expect(invokeTeamFunction('team-invitations', {}, anything)).rejects.toMatchObject({
      code: 'ALREADY_INVITED',
      retryable: false
    });
  });

  it('preserves a permission refusal rather than reporting storage trouble', async () => {
    invoke.mockResolvedValue(
      httpFailure(403, { ok: false, error: { code: 'PERMISSION_DENIED', retryable: false } })
    );

    await expect(invokeTeamFunction('drive-ops', {}, anything)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
  });

  it('still reports a retryable failure when there is no envelope to read', async () => {
    const error = Object.assign(new Error('Failed to send a request'), {
      name: 'FunctionsFetchError',
      context: new TypeError('network down')
    });
    invoke.mockResolvedValue({ data: null, error });

    const caught = await invokeTeamFunction('drive-connect', {}, anything).catch(value => value);
    expect(caught).toBeInstanceOf(TeamApiError);
    expect(caught).toMatchObject({ code: 'DRIVE_UNAVAILABLE', retryable: true });
  });

  it('reports a non-JSON error body as a retryable failure, not a bogus code', async () => {
    const response = new Response('<html>gateway timeout</html>', {
      status: 504,
      headers: { 'content-type': 'text/html' }
    });
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('non-2xx'), { name: 'FunctionsHttpError', context: response })
    });

    await expect(invokeTeamFunction('catalog-sync', {}, anything)).rejects.toMatchObject({
      code: 'DRIVE_UNAVAILABLE',
      retryable: true
    });
  });

  it('returns the value of a successful call unchanged', async () => {
    invoke.mockResolvedValue({ data: { ok: true, value: { state: 'connected' } }, error: null });

    await expect(invokeTeamFunction('drive-connect', {}, anything)).resolves.toEqual({
      state: 'connected'
    });
  });
});
