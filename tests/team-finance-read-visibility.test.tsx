// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { useAgentFinance } from '../apps/web/src/team/accounts/finance/useAgentFinance';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: { snapshot: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const result = (date = '2026-11-03'): FinanceSnapshot => ({
  schemaVersion: 2,
  teamId: 'team',
  teamName: 'Team',
  from: date,
  to: date,
  timezone: 'UTC',
  currency: 'USD',
  generatedAt: '2026-11-03T10:00:00Z',
  accounts: [],
  agents: [],
  placements: [],
  fields: []
});
it.each([false, true])(
  'defers hidden automatic finance reads and catches up once (v2=%s)',
  async v2 => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const read = vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(result());
    const view = renderHook(
      ({ revision }) =>
        useAgentFinance('team', '2026-11-03', '2026-11-03', 'UTC', revision, true, v2),
      { initialProps: { revision: 0 } }
    );
    for (let revision = 1; revision <= 10; revision++) {
      view.rerender({ revision });
      act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'team' })));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(read).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(301);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.result.current.snapshot?.teamId).toBe('team');
  }
);
it('bounds a stalled prepared-period read and lets explicit navigation retry while hidden', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const read = vi
    .mocked(teamFinanceApi.snapshot)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(result('2026-11-04'));
  const view = renderHook(() =>
    useAgentFinance('team', '2026-11-03', '2026-11-03', 'UTC', 0, true, true)
  );
  const pending = view.result.current.preparePeriod('2026-11-04', '2026-11-04');
  const rejected = expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_READ_TIMEOUT' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  await rejected;
  expect(read.mock.calls[0]![5]?.signal?.aborted).toBe(true);
  await act(async () => {
    expect(await view.result.current.preparePeriod('2026-11-04', '2026-11-04')).toEqual(
      result('2026-11-04')
    );
  });
  expect(read).toHaveBeenCalledTimes(2);
});
