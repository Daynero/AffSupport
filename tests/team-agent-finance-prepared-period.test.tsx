// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { useAgentFinance } from '../apps/web/src/team/accounts/finance/useAgentFinance';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: { snapshot: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
function snapshot(teamId: string, date: string, timezone = 'UTC'): FinanceSnapshot {
  return {
    schemaVersion: 2,
    teamId,
    teamName: teamId,
    from: date,
    to: date,
    timezone,
    currency: 'USD',
    generatedAt: '2026-10-19T00:00:00Z',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it('prepares without changing the selected day, then commits a complete cached day without a null render or duplicate fetch', async () => {
  const first = snapshot('a', '2026-10-19');
  const second = snapshot('a', '2026-10-18');
  const pending = deferred<FinanceSnapshot>();
  const read = vi
    .mocked(teamFinanceApi.snapshot)
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(pending.promise);
  const renders: Array<string | null> = [];
  const view = renderHook(
    ({ date }) => {
      const state = useAgentFinance('a', date, date, 'UTC', 0, true, true, 'buyer/edit');
      renders.push(state.snapshot?.from ?? null);
      return state;
    },
    { initialProps: { date: first.from } }
  );
  await waitFor(() => expect(view.result.current.snapshot).toBe(first));
  let preparing!: Promise<FinanceSnapshot | null>;
  act(() => {
    preparing = view.result.current.preparePeriod(second.from, second.to);
  });
  expect(view.result.current.snapshot).toBe(first);
  expect(view.result.current.loading).toBe(false);
  await act(async () => {
    pending.resolve(second);
    await preparing;
  });
  expect(view.result.current.snapshot).toBe(first);
  expect(view.result.current.presentPrepared(second)).toBe(true);
  expect(view.result.current.snapshot).toBe(first);
  renders.length = 0;
  act(() => view.rerender({ date: second.from }));
  expect(view.result.current.snapshot).toBe(second);
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.every(date => date === second.from)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  act(() => view.rerender({ date: first.from }));
  expect(view.result.current.snapshot).toBe(first);
  expect(read).toHaveBeenCalledTimes(2);
});
it('deduplicates concurrent preparations and does not present an out-of-order prepared day', async () => {
  const one = snapshot('a', '2026-10-19'),
    two = snapshot('a', '2026-10-18'),
    three = snapshot('a', '2026-10-17');
  const slow = deferred<FinanceSnapshot>(),
    fast = deferred<FinanceSnapshot>();
  const read = vi
    .mocked(teamFinanceApi.snapshot)
    .mockResolvedValueOnce(one)
    .mockReturnValueOnce(slow.promise)
    .mockReturnValueOnce(fast.promise);
  const view = renderHook(({ date }) => useAgentFinance('a', date, date, 'UTC', 0, true, true), {
    initialProps: { date: one.from }
  });
  await waitFor(() => expect(view.result.current.snapshot).toBe(one));
  const older = view.result.current.preparePeriod(two.from, two.to);
  const duplicate = view.result.current.preparePeriod(two.from, two.to);
  const newer = view.result.current.preparePeriod(three.from, three.to);
  await act(async () => {
    fast.resolve(three);
    await newer;
  });
  act(() => {
    expect(view.result.current.presentPrepared(three)).toBe(true);
    view.rerender({ date: three.from });
  });
  await act(async () => {
    slow.resolve(two);
    await older;
    await duplicate;
  });
  expect(view.result.current.snapshot).toBe(three);
  expect(read).toHaveBeenCalledTimes(3);
});
it.each(['team', 'timezone', 'actor', 'permission', 'disabled'])(
  'rejects late prepared data across a %s lifetime change',
  async change => {
    const one = snapshot('a', '2026-10-19');
    const pending = deferred<FinanceSnapshot>();
    vi.mocked(teamFinanceApi.snapshot)
      .mockResolvedValueOnce(one)
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (team, from, _to, timezone) => snapshot(team, from, timezone));
    const initial = { team: 'a', timezone: 'UTC', scope: 'actor/edit', enabled: true };
    const view = renderHook(
      props =>
        useAgentFinance(
          props.team,
          one.from,
          one.to,
          props.timezone,
          0,
          props.enabled,
          true,
          props.scope
        ),
      { initialProps: initial }
    );
    await waitFor(() => expect(view.result.current.snapshot).toBe(one));
    const oldPresent = view.result.current.presentPrepared;
    const preparing = view.result.current.preparePeriod('2026-10-18', '2026-10-18');
    const next = {
      ...initial,
      ...(change === 'team'
        ? { team: 'b' }
        : change === 'timezone'
          ? { timezone: 'Europe/Kyiv' }
          : change === 'disabled'
            ? { enabled: false }
            : { scope: change === 'actor' ? 'other/edit' : 'actor/view' })
    };
    await act(async () => view.rerender(next));
    let prepared: FinanceSnapshot | null | undefined;
    await act(async () => {
      pending.resolve(snapshot('a', '2026-10-18'));
      prepared = await preparing;
    });
    expect(prepared).toBeNull();
    expect(oldPresent(one)).toBe(false);
    if (!next.enabled) expect(view.result.current.snapshot).toBeNull();
    else {
      expect(view.result.current.snapshot?.teamId).toBe(next.team);
      expect(view.result.current.snapshot?.timezone).toBe(next.timezone);
      expect(view.result.current.snapshot).not.toBe(one);
    }
  }
);
it('invalidates a prepared period after a committed field mutation and bounds the cache to three periods', async () => {
  const read = vi
    .mocked(teamFinanceApi.snapshot)
    .mockImplementation(async (team, from, _to, timezone) => snapshot(team, from, timezone));
  const view = renderHook(() =>
    useAgentFinance('a', '2026-10-19', '2026-10-19', 'UTC', 0, true, true)
  );
  await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
  const prepared = await view.result.current.preparePeriod('2026-10-18', '2026-10-18');
  if (!prepared) throw new Error('Preparation failed');
  act(() => view.result.current.applyFields([]));
  expect(view.result.current.presentPrepared(prepared)).toBe(false);
  for (const date of ['2026-10-18', '2026-10-17', '2026-10-16'])
    await view.result.current.preparePeriod(date, date);
  const before = read.mock.calls.length;
  await view.result.current.preparePeriod('2026-10-18', '2026-10-18');
  expect(read).toHaveBeenCalledTimes(before);
  await view.result.current.preparePeriod('2026-10-19', '2026-10-19');
  expect(read).toHaveBeenCalledTimes(before + 1);
});
it('clears protected snapshots when a preparation discovers revoked permission', async () => {
  const one = snapshot('a', '2026-10-19');
  vi.mocked(teamFinanceApi.snapshot)
    .mockResolvedValueOnce(one)
    .mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
  const view = renderHook(() => useAgentFinance('a', one.from, one.to, 'UTC', 0, true, true));
  await waitFor(() => expect(view.result.current.snapshot).toBe(one));
  await act(async () => {
    await expect(view.result.current.preparePeriod('2026-10-18', '2026-10-18')).rejects.toThrow(
      'PERMISSION_DENIED'
    );
  });
  expect(view.result.current.snapshot).toBeNull();
  expect(view.result.current.presentPrepared(one)).toBe(false);
});
