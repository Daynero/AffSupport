// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import * as claimAnalytics from '../apps/web/src/team/catalog-updater/analytics';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const installed = vi.hoisted(() => ({ version: vi.fn(), refusals: vi.fn(), invoke: vi.fn() }));
vi.mock('../apps/web/src/api/client', () => ({
  agentRestitchContractVersion: installed.version,
  getRestitchScreenRefusals: installed.refusals,
  startTeamAgentProcess: vi.fn(),
  cancelTeamAgentProcess: vi.fn(),
  toolEventUrl: vi.fn()
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, value: { supabaseUrl: 'http://127.0.0.1:54321' } }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ functions: { invoke: installed.invoke } }),
  getSupabaseClient: () => ({ functions: { invoke: installed.invoke } })
}));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: vi.fn() }));
vi.mock('../apps/web/src/api/recovery', () => ({
  backgroundRecoveryStatus: vi.fn(),
  RECOVERY_CHANGED: 'recovery'
}));
const A = '47000000-0000-4000-8000-000000000081';
const B = '47000000-0000-4000-8000-000000000082';
beforeEach(() => setPrivateCacheScope(A, 'allowed'));
const { useRestitchPreparer } =
  await import('../apps/web/src/team/catalog-updater/useRestitchPreparer');
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it.each([1, 2])(
  'advertises installed screen protocol %s rather than the current page version',
  async version => {
    vi.useFakeTimers();
    installed.version.mockResolvedValue(version);
    installed.refusals.mockResolvedValue([]);
    installed.invoke.mockResolvedValue({ data: { ok: true, value: { job: null } }, error: null });
    const hook = renderHook(() => useRestitchPreparer({ teamId: 'team', enabled: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3001);
    });
    expect(installed.invoke).toHaveBeenCalledOnce();
    expect(installed.invoke.mock.calls[0]?.[1]?.body.restitchContractVersion).toBe(version);
    expect(installed.version).toHaveBeenCalledOnce();
    expect(installed.refusals).toHaveBeenCalledTimes(version >= 2 ? 1 : 0);
    hook.unmount();
  }
);

it('does not take a cloud job when the installed executor cannot answer health', async () => {
  vi.useFakeTimers();
  installed.version.mockRejectedValue(new Error('AGENT_REQUIRED'));
  installed.refusals.mockResolvedValue([]);
  installed.invoke.mockResolvedValue({ data: { ok: true, value: { job: null } }, error: null });
  const hook = renderHook(() => useRestitchPreparer({ teamId: 'team', enabled: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3001);
  });
  expect(installed.invoke).not.toHaveBeenCalled();
  expect(installed.refusals).not.toHaveBeenCalled();
  hook.unmount();
});

it.each([1, 2])(
  'distinguishes an old installed executor from an outdated page at protocol %s',
  async version => {
    vi.useFakeTimers();
    installed.version.mockResolvedValue(version);
    installed.refusals.mockResolvedValue([]);
    installed.invoke.mockResolvedValue({
      data: { ok: false, error: { code: 'RESTITCH_CLIENT_OUTDATED', retryable: false } },
      error: null
    });
    const onAgentOutdated = vi.fn(),
      onOutdated = vi.fn();
    const hook = renderHook(() =>
      useRestitchPreparer({ teamId: 'team', enabled: true, onAgentOutdated, onOutdated })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(33001);
    });
    expect(onAgentOutdated).toHaveBeenCalledTimes(version === 1 ? 1 : 0);
    expect(onOutdated).toHaveBeenCalledTimes(version === 2 ? 1 : 0);
    expect(installed.invoke).toHaveBeenCalledOnce();
    hook.unmount();
  }
);

it('continues capability checks and cloud claiming when diagnostic initialization fails', async () => {
  vi.useFakeTimers();
  vi.spyOn(claimAnalytics, 'beginCatalogUiFlow').mockImplementationOnce(() => {
    throw new Error('SYNTHETIC_TELEMETRY_FAILURE');
  });
  installed.version.mockResolvedValue(2);
  installed.refusals.mockResolvedValue([]);
  installed.invoke.mockResolvedValue({ data: { ok: true, value: { job: null } }, error: null });
  const hook = renderHook(() => useRestitchPreparer({ teamId: 'team', enabled: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3001);
  });
  expect(installed.version).toHaveBeenCalledOnce();
  expect(installed.invoke).toHaveBeenCalledOnce();
  hook.unmount();
});

it('does not claim as a replacement actor after an installed-executor probe finishes', async () => {
  vi.useFakeTimers();
  let finish!: (version: number) => void;
  installed.version.mockImplementation(
    () =>
      new Promise<number>(resolve => {
        finish = resolve;
      })
  );
  installed.refusals.mockResolvedValue([]);
  installed.invoke.mockResolvedValue({ data: { ok: true, value: { job: null } }, error: null });
  const hook = renderHook(() => useRestitchPreparer({ teamId: 'team', enabled: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3001);
  });
  setPrivateCacheScope(B, 'allowed');
  await act(async () => {
    finish(2);
  });
  expect(installed.invoke).not.toHaveBeenCalled();
  expect(installed.refusals).not.toHaveBeenCalled();
  hook.unmount();
});
