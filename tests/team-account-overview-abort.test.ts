import { afterEach, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc }),
  withFreshSession: <T>(run: () => PromiseLike<T>) => run()
}));
const { accountsWorkspaceApi } = await import('../apps/web/src/api/team-accounts-workspace');
const { teamFinanceApi } = await import('../apps/web/src/api/team-finance');
afterEach(() => rpc.mockReset());

it.each([
  ['overview', () => accountsWorkspaceApi.overview('team', '2026-11-01', '2026-11-03', 'UTC')],
  ['finance', () => teamFinanceApi.snapshot('team', '2026-11-01', '2026-11-03', 'UTC')]
] as const)(
  'normalizes account read errors through the canonical seam: %s',
  async (_name, read) => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'duplicate key', code: '23505' } });
    await expect(read()).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'AbortError: operation aborted' } });
    await expect(read()).rejects.toMatchObject({ name: 'AbortError' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'UNRECOGNIZED_NOT_FOUND_SUFFIX' } });
    await expect(read()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'ACCOUNT_ORDER_CONFLICT' } });
    await expect(read()).rejects.toMatchObject({ code: 'ACCOUNT_ORDER_CONFLICT' });
  }
);

it('carries the overview deadline signal through both the accounts and private seed RPCs', async () => {
  const applied: AbortSignal[] = [];
  rpc.mockImplementation((name: string) => {
    const result = Promise.resolve({
      data:
        name === 'get_team_accounts_overview'
          ? {
              schemaVersion: 1,
              accounts: [],
              socialOrderVersion: '0',
              agentOrderVersions: {},
              coverage: 'complete'
            }
          : [],
      error: null
    });
    return Object.assign(result, {
      abortSignal(signal: AbortSignal) {
        applied.push(signal);
        return result;
      }
    });
  });
  const controller = new AbortController();
  await expect(
    accountsWorkspaceApi.overview('team', '2026-11-01', '2026-11-03', 'UTC', {
      signal: controller.signal
    })
  ).resolves.toMatchObject({ accounts: [] });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'get_team_accounts_overview',
    'list_team_account_two_factor_seeds'
  ]);
  expect(applied).toEqual([controller.signal, controller.signal]);
  controller.abort();
  expect(applied.every(signal => signal.aborted)).toBe(true);
});
