// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAccounts } from '../apps/web/src/team/accounts/useAccounts';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { overview: vi.fn() }
}));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
type Overview = Awaited<ReturnType<typeof accountsWorkspaceApi.overview>>;
function response(): Overview {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    accounts: [],
    socialOrderVersion: '7',
    agentOrderVersions: {},
    launchCoverage: 'partial',
    launchSummaries: []
  };
}
it('ignores an old team overview arriving after the new team canonical commit', async () => {
  let release!: (value: Overview) => void;
  vi.mocked(accountsWorkspaceApi.overview)
    .mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve;
      })
    )
    .mockResolvedValueOnce(response());
  const hook = renderHook(
    ({ teamId }) => useAccounts({ teamId, from: '2026-10-17', to: '2026-10-18', timezone: 'UTC' }),
    { initialProps: { teamId: 'old-team' } }
  );
  const oldFlow = vi
    .mocked(emitAccountSignal)
    .mock.calls.find(
      ([action, stage]) => action === 'overview' && stage === 'requested'
    )?.[2].flowId;
  hook.rerender({ teamId: 'new-team' });
  await waitFor(() => expect(hook.result.current.orderVersions.socials).toBe('7'));
  await act(async () => {
    release({ ...response(), socialOrderVersion: '2', launchCoverage: 'complete' });
  });
  expect(hook.result.current.orderVersions.socials).toBe('7');
  expect(hook.result.current.launchCoverage).toBe('partial');
  expect(hook.result.current.error).toBeNull();
  expect(emitAccountSignal).toHaveBeenCalledWith(
    'overview',
    'terminal',
    expect.objectContaining({ flowId: oldFlow, result: 'cancelled' })
  );
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(
        ([action, stage, props]) =>
          action === 'overview' && stage === 'applied' && props.flowId === oldFlow
      )
  ).toBe(false);
});
it('does not turn a late old-team read failure into the new team error', async () => {
  let reject!: (cause: Error) => void;
  vi.mocked(accountsWorkspaceApi.overview)
    .mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      })
    )
    .mockResolvedValueOnce(response());
  const hook = renderHook(
    ({ teamId }) => useAccounts({ teamId, from: '2026-10-17', to: '2026-10-18', timezone: 'UTC' }),
    { initialProps: { teamId: 'old-team' } }
  );
  hook.rerender({ teamId: 'new-team' });
  await waitFor(() => expect(hook.result.current.orderVersions.socials).toBe('7'));
  await act(async () => {
    reject(Object.assign(new Error('old denied'), { code: 'PERMISSION_DENIED' }));
  });
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.loading).toBe(false);
});
