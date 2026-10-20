// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamAccountAgentSummary, TeamAccountNameColor } from '@video-compressor/shared';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { useAccountPreferences } from '../apps/web/src/team/accounts/useAccountPreferences';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';

vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { color: vi.fn() }
}));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function agent(): TeamAccountAgentSummary {
  return {
    id: 'rk',
    accountId: 'social',
    teamId: 'team',
    agentId: '926',
    runs: [],
    labels: [],
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    nameColor: 0,
    nameColorVersion: '0'
  };
}
it('serializes rapid intent and completes all eight colors without losing the last click', async () => {
  const row = agent();
  let resolveFirst!: (value: Awaited<ReturnType<typeof accountsWorkspaceApi.color>>) => void;
  vi.mocked(accountsWorkspaceApi.color)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    )
    .mockResolvedValue({
      operationId: 'op2',
      requestId: 'req2',
      agentId: 'rk',
      color: 0,
      version: '2'
    });
  const view = renderHook(() => useAccountPreferences('team', [row], vi.fn()));
  act(() => {
    for (let i = 0; i < 8; i++) view.result.current.cycle(row);
  });
  expect(view.result.current.color(row)).toBe(0);
  expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveFirst({ operationId: 'op1', requestId: 'req1', agentId: 'rk', color: 1, version: '1' });
  });
  await waitFor(() => expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(2));
  expect(vi.mocked(accountsWorkspaceApi.color).mock.calls[1]?.slice(0, 4)).toEqual([
    'team',
    'rk',
    0,
    '1'
  ]);
  expect(view.result.current.color(row)).toBe(0);
});
it('adopts a newer own-session canonical preference and ignores an older overview', async () => {
  const row = agent();
  vi.mocked(accountsWorkspaceApi.color).mockResolvedValue({
    operationId: 'op1',
    requestId: 'req1',
    agentId: 'rk',
    color: 1,
    version: '1'
  });
  const view = renderHook(({ rows }) => useAccountPreferences('team', rows, vi.fn()), {
    initialProps: { rows: [row] }
  });
  await act(async () => {
    view.result.current.cycle(row);
  });
  view.rerender({ rows: [{ ...row, nameColor: 4, nameColorVersion: '2' }] });
  await waitFor(() => expect(view.result.current.color(row)).toBe(4));
  view.rerender({ rows: [row] });
  expect(view.result.current.color(row)).toBe(4);
});

it('replays an interrupted preference response using the identical request and version', async () => {
  const row = agent();
  const fail = vi.fn();
  vi.mocked(accountsWorkspaceApi.color)
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue({
      operationId: 'op',
      requestId: 'req',
      agentId: 'rk',
      color: 1,
      version: '1'
    });
  const view = renderHook(() => useAccountPreferences('team', [row], fail));
  await act(async () => {
    view.result.current.cycle(row);
  });
  expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(2);
  expect(vi.mocked(accountsWorkspaceApi.color).mock.calls[1]).toEqual(
    vi.mocked(accountsWorkspaceApi.color).mock.calls[0]
  );
  expect(view.result.current.color(row)).toBe(1);
  expect(fail).not.toHaveBeenCalled();
});

it('retains the acknowledged decoration across rename, move, archive/restore and a new session', async () => {
  const row = agent();
  const originalBusinessData = JSON.stringify(row);
  let saved: { color: TeamAccountNameColor; version: string } = { color: 0, version: '0' };
  vi.mocked(accountsWorkspaceApi.color).mockImplementation(async (_team, id, color) => {
    saved = { color, version: String(Number(saved.version) + 1) };
    return { operationId: 'op', requestId: 'req', agentId: id, ...saved };
  });
  const error = vi.fn();
  const view = renderHook(({ rows }) => useAccountPreferences('team', rows, error), {
    initialProps: { rows: [row] }
  });
  for (let index = 1; index <= 8; index++) {
    await act(async () => view.result.current.cycle(row));
    expect(saved.color).toBe(index % 8);
    expect(view.result.current.color(row)).toBe(index % 8);
  }
  await act(async () => view.result.current.cycle(row));
  const renamedAndMoved = {
    ...row,
    agentId: 'renamed-id',
    accountId: 'other-social',
    nameColor: saved.color,
    nameColorVersion: saved.version
  };
  view.rerender({ rows: [renamedAndMoved] });
  expect(view.result.current.color(renamedAndMoved)).toBe(1);
  view.rerender({ rows: [{ ...renamedAndMoved, archivedAt: '2026-10-18T06:00:00Z' }] });
  view.rerender({ rows: [{ ...renamedAndMoved, archivedAt: null }] });
  expect(view.result.current.color(renamedAndMoved)).toBe(1);
  expect(JSON.stringify(row)).toBe(originalBusinessData);
  expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(9);
  view.unmount();
  const reopened = renderHook(() => useAccountPreferences('team', [renamedAndMoved], error));
  expect(reopened.result.current.color(renamedAndMoved)).toBe(1);
  expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(9);
  expect(error).not.toHaveBeenCalled();
});

it('rolls a rejected write back to the latest canonical color after a concurrent update', async () => {
  const row = agent();
  let reject!: (cause: Error) => void;
  vi.mocked(accountsWorkspaceApi.color).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  const error = vi.fn();
  const view = renderHook(({ rows }) => useAccountPreferences('team', rows, error), {
    initialProps: { rows: [row] }
  });
  act(() => view.result.current.cycle(row));
  view.rerender({ rows: [{ ...row, nameColor: 6, nameColorVersion: '3' }] });
  await act(async () => reject(new Error('PERMISSION_DENIED')));
  expect(view.result.current.color(row)).toBe(6);
  expect(error).toHaveBeenCalledTimes(1);
  expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(1);
  expect(emitAccountSignal).toHaveBeenCalledWith(
    'decoration',
    'terminal',
    expect.objectContaining({
      outcome: 'failure',
      code: 'PERMISSION_DENIED'
    })
  );
});

it('ignores a late preference response after the owning workspace unmounts', async () => {
  const row = agent();
  let resolve!: (value: Awaited<ReturnType<typeof accountsWorkspaceApi.color>>) => void;
  vi.mocked(accountsWorkspaceApi.color).mockImplementationOnce(
    () =>
      new Promise(yes => {
        resolve = yes;
      })
  );
  const error = vi.fn();
  const view = renderHook(() => useAccountPreferences('team', [row], error));
  act(() => view.result.current.cycle(row));
  view.unmount();
  await act(async () =>
    resolve({ operationId: 'op', requestId: 'req', agentId: row.id, color: 1, version: '1' })
  );
  expect(error).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(
        ([kind, phase]) => kind === 'decoration' && (phase === 'accepted' || phase === 'applied')
      )
  ).toBe(false);
});
