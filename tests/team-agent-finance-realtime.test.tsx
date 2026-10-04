// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { useAgentFinance } from '../apps/web/src/team/accounts/finance/useAgentFinance';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: { snapshot: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const snapshot = (teamId: string): FinanceSnapshot => ({
  schemaVersion: 1,
  teamId,
  teamName: teamId,
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'USD',
  generatedAt: '2026-10-03T10:00:00Z',
  accounts: [],
  agents: [],
  placements: [],
  fields: []
});
it('coalesces a burst during an in-flight read into one follow-up and accepts later events', async () => {
  vi.useFakeTimers();
  let resolve: (s: FinanceSnapshot) => void = () => {};
  const read = vi.mocked(teamFinanceApi.snapshot);
  read
    .mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    )
    .mockResolvedValue(snapshot('a'));
  const view = renderHook(() => useAgentFinance('a', '2026-09-01', '2026-09-30', 'UTC', 0));
  for (let n = 0; n < 20; n++)
    act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'a' })));
  await act(async () => resolve(snapshot('a')));
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(read).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'a' })));
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(read).toHaveBeenCalledTimes(3);
  expect(view.result.current.snapshot?.teamId).toBe('a');
});
it('drops late responses from another team and clears a revoked snapshot', async () => {
  vi.useFakeTimers();
  let resolve: (s: FinanceSnapshot) => void = () => {};
  const read = vi.mocked(teamFinanceApi.snapshot);
  read
    .mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    )
    .mockResolvedValueOnce(snapshot('b'));
  const view = renderHook(
    ({ team }) => useAgentFinance(team, '2026-09-01', '2026-09-30', 'UTC', 0),
    { initialProps: { team: 'a' } }
  );
  await act(async () => view.rerender({ team: 'b' }));
  await act(async () => resolve(snapshot('a')));
  expect(view.result.current.snapshot?.teamId).toBe('b');
  read.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
  act(() => view.result.current.refresh());
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(view.result.current.snapshot).toBe(null);
});
