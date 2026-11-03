// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAccounts, type AccountsClient } from '../apps/web/src/team/accounts/useAccounts';
import { deferred } from './fixtures/catalog-sync';
import { analytics } from '../apps/web/src/analytics/service';
import type { TeamAccountSummary, TeamAccountAgentSummary } from '@video-compressor/shared';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const account: TeamAccountSummary = {
  id: 'account',
  teamId: 'team',
  name: 'original',
  agents: [],
  createdAt: '2026-11-03T10:00:00Z',
  updatedAt: '2026-11-03T10:00:00Z'
};

it('keeps a newer canonical account when its delayed create receipt arrives after realtime', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const receipt = deferred<TeamAccountSummary>();
  const canonical = { ...account, name: 'renamed by teammate', updatedAt: '2026-11-03T10:00:01Z' };
  const client = {
    listAccounts: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([canonical]),
    createAccount: vi.fn().mockReturnValue(receipt.promise)
  } as unknown as AccountsClient;
  const view = renderHook(({ revision }) => useAccounts({ teamId: 'team', client, revision }), {
    initialProps: { revision: 0 }
  });
  await act(async () => {});
  let create!: Promise<TeamAccountSummary>;
  act(() => {
    create = view.result.current.createAccount('original');
  });
  await act(async () => view.rerender({ revision: 1 }));
  expect(view.result.current.accounts).toEqual([canonical]);
  await act(async () => {
    receipt.resolve(account);
    await create;
  });
  expect(view.result.current.accounts).toEqual([canonical]);
  expect(track).toHaveBeenCalledWith(
    'team_account_visible',
    expect.objectContaining({
      account_action: 'retained_action',
      account_operation: 'createAccount',
      account_result: 'complete'
    })
  );
});

it('keeps a canonical agent observed before its delayed creation receipt', async () => {
  const created: TeamAccountAgentSummary = {
    id: 'agent',
    accountId: account.id,
    teamId: 'team',
    agentId: '123',
    runs: [],
    labels: [],
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
  const canonical = { ...created, agentId: 'renamed', updatedAt: '2026-11-03T10:00:01Z' };
  const receipt = deferred<TeamAccountAgentSummary>();
  const client = {
    listAccounts: vi
      .fn()
      .mockResolvedValueOnce([account])
      .mockResolvedValue([{ ...account, agents: [canonical] }]),
    addAccountAgent: vi.fn().mockReturnValue(receipt.promise)
  } as unknown as AccountsClient;
  const view = renderHook(({ revision }) => useAccounts({ teamId: 'team', client, revision }), {
    initialProps: { revision: 0 }
  });
  await act(async () => {});
  let add!: Promise<TeamAccountAgentSummary>;
  act(() => {
    add = view.result.current.addAgent(account.id, '123', null);
  });
  await act(async () => view.rerender({ revision: 1 }));
  expect(view.result.current.accounts[0]?.agents).toEqual([canonical]);
  await act(async () => {
    receipt.resolve(created);
    await add;
  });
  expect(view.result.current.accounts[0]?.agents).toEqual([canonical]);
});

it('coalesces account revisions while its authoritative read is pending', async () => {
  const first = deferred<[]>();
  const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([]);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(({ revision }) => useAccounts({ teamId: 'team', client, revision }), {
    initialProps: { revision: 0 }
  });
  await act(async () => {});
  for (let revision = 1; revision <= 10; revision++) view.rerender({ revision });
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve([]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.result.current.loading).toBe(false);
});

it('defers automatic account reads while hidden and catches up once on return', async () => {
  let visibility: DocumentVisibilityState = 'hidden';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const list = vi.fn().mockResolvedValue([]);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(({ revision }) => useAccounts({ teamId: 'team', client, revision }), {
    initialProps: { revision: 7 }
  });
  view.rerender({ revision: 8 });
  await act(async () => {});
  expect(list).not.toHaveBeenCalled();
  visibility = 'visible';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(list).toHaveBeenCalledTimes(1);
});

it('bounds a stalled account read, aborts it and permits an explicit retry', async () => {
  vi.useFakeTimers();
  const stalled = deferred<[]>();
  const list = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValue([]);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'team', client }));
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toBe('WORKSPACE_READ_TIMEOUT');
  expect(track).toHaveBeenCalledWith(
    'team_account_terminal',
    expect.objectContaining({
      account_action: 'overview',
      account_code: 'WORKSPACE_READ_TIMEOUT',
      account_result: 'failed'
    })
  );
  expect((list.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  await act(async () => expect(await view.result.current.refetch()).toEqual([]));
  await act(async () => stalled.resolve([]));
  expect(view.result.current.error).toBeNull();
});

it('strict refetch waits for the fresh follow-up and returns null after its owner retires', async () => {
  const first = deferred<[]>();
  const second = deferred<[]>();
  const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'team', client }));
  await act(async () => {});
  const refetch = view.result.current.refetch;
  let settled = false;
  const requested = refetch().then(result => {
    settled = true;
    return result;
  });
  await act(async () => first.resolve([]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);
  await act(async () => second.resolve([]));
  expect(await requested).toEqual([]);
  view.unmount();
  expect(await refetch()).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});

it('requests a fresh follow-up when a local write invalidates the pending snapshot', async () => {
  const first = deferred<[]>();
  const list = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([]);
  const client = {
    listAccounts: list,
    clearAgentRunMarkers: vi.fn().mockResolvedValue([])
  } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'team', client }));
  await act(async () => {});
  await act(async () => view.result.current.clearMarkers());
  await act(async () => first.resolve([]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.result.current.loading).toBe(false);
});

it('keeps manual confirmation pending until a write-invalidated read is actually replaced', async () => {
  const old = deferred<TeamAccountSummary[]>();
  const fresh = deferred<TeamAccountSummary[]>();
  const canonical = { ...account, name: 'fresh after write' };
  const list = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const client = {
    listAccounts: list,
    clearAgentRunMarkers: vi.fn().mockResolvedValue([])
  } as unknown as AccountsClient;
  const view = renderHook(() => useAccounts({ teamId: 'team', client }));
  await act(async () => {});
  let settled = false;
  const confirmation = view.result.current.refetch().then(value => {
    settled = true;
    return value;
  });
  await act(async () => {});
  await act(async () => view.result.current.clearMarkers());
  await act(async () => old.resolve([account]));
  expect(list).toHaveBeenCalledTimes(3);
  expect(settled).toBe(false);
  expect(view.result.current.accounts).toEqual([]);
  await act(async () => fresh.resolve([canonical]));
  expect(await confirmation).toEqual([canonical]);
  expect(view.result.current.accounts).toEqual([canonical]);
});

it('keeps a retired strict refetch retired after a team round trip', async () => {
  const list = vi.fn().mockResolvedValue([]);
  const client = { listAccounts: list } as unknown as AccountsClient;
  const view = renderHook(({ teamId }) => useAccounts({ teamId, client }), {
    initialProps: { teamId: 'a' }
  });
  await act(async () => {});
  const oldA = view.result.current.refetch;
  await act(async () => view.rerender({ teamId: 'b' }));
  await act(async () => view.rerender({ teamId: 'a' }));
  const reads = list.mock.calls.length;
  expect(await oldA()).toBeNull();
  expect(list).toHaveBeenCalledTimes(reads);
});

it('returns a canonical manual refetch while hidden after an automatic read is already pending', async () => {
  const first = deferred<[]>();
  const second = deferred<[]>();
  const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const client = { listAccounts: list } as unknown as AccountsClient;
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const view = renderHook(() => useAccounts({ teamId: 'team', client }));
  await act(async () => {});
  visibility = 'hidden';
  const pending = view.result.current.refetch();
  await act(async () => first.resolve([]));
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve([]));
  expect(await pending).toEqual([]);
});
