// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const context = vi.hoisted(() => ({ revision: 42 }));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => context }));
import {
  useCatalogRegistry,
  useCatalogUpdater,
  type CatalogUpdaterClient
} from '../apps/web/src/team/catalog-updater/useCatalogUpdater';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('catalog registry first read', () => {
  it('refreshes spare preparation before an update is due and stops when ready', async () => {
    vi.useFakeTimers();
    const row = {
      catalogId: 'catalog',
      updatePending: false,
      profile: { restitch: true, restitchStatus: 'preparing' }
    } as CatalogRegistryRow;
    const list = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValue([{ ...row, profile: { ...row.profile, restitchStatus: 'ready' } }]);
    const client = { listTeamProductCatalogs: list } as unknown as CatalogUpdaterClient;
    const view = renderHook(() => useCatalogRegistry('team', true, client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('polls confirmed active work and stops the fast poll once the server reports completion', async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ activeCount: 1, serverNow: new Date().toISOString() })
      .mockResolvedValue({ activeCount: 0, serverNow: new Date().toISOString() });
    const client = { getCatalogUpdater: get } as unknown as CatalogUpdaterClient;
    const view = renderHook(() => useCatalogUpdater('team', client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.state?.activeCount).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(view.result.current.state?.activeCount).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('loads immediately at an existing realtime revision and retains embedded profiles', async () => {
    vi.useFakeTimers();
    const profile = { catalogId: 'catalog', version: 7 };
    const row = { catalogId: 'catalog', profile } as CatalogRegistryRow;
    const list = vi.fn().mockResolvedValue([row]);
    const client = { listTeamProductCatalogs: list } as unknown as CatalogUpdaterClient;
    const { result } = renderHook(() => useCatalogRegistry('team', true, client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.rows?.[0]?.profile).toEqual(profile);
    await act(async () => {
      await result.current.reload();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });
});

it('follows a deferred link closely around its time and reads again the moment it comes', async () => {
  // 1.4.3 QA round 9: «Посилання о 21:34» lingered ~56 s past its time on the
  // one-minute floor, and a video count lagged by up to a minute.
  vi.useFakeTimers();
  try {
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    const row = (dueAt: string, waitingForVideos = false) =>
      ({
        catalogId: 'catalog',
        updatePending: false,
        videoPublication: { dueAt, timeZone: 'UTC', waitingForVideos }
      }) as unknown as CatalogRegistryRow;
    // Ten minutes away: only the floor and one read at the time itself.
    const list = vi.fn().mockResolvedValue([row(later)]);
    const client = { listTeamProductCatalogs: list } as unknown as CatalogUpdaterClient;
    const view = renderHook(() => useCatalogRegistry('team', true, client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(list.mock.calls.length).toBe(first);
    // Waiting for its videos: followed like a running round.
    list.mockResolvedValue([row(new Date(Date.now() - 1_000).toISOString(), true)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const before = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(before + 3);
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it('reads once more right after the earliest scheduled time', async () => {
  vi.useFakeTimers();
  try {
    const dueAt = new Date(Date.now() + 3 * 60_000).toISOString();
    // Every read is a new answer, as from the server.
    const list = vi.fn().mockImplementation(async () => [
      {
        catalogId: 'catalog',
        updatePending: false,
        videoPublication: { dueAt, timeZone: 'UTC', waitingForVideos: false }
      }
    ]);
    const client = { listTeamProductCatalogs: list } as unknown as CatalogUpdaterClient;
    const view = renderHook(() => useCatalogRegistry('team', true, client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const due = Date.parse(dueAt);
    // Up to a minute before the time only the one-minute floor reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(due - 60_000 - Date.now() - 1_000);
    });
    const quiet = list.mock.calls.length;
    // Inside the last minute it is followed every few seconds, and read right after the time.
    // Step through it: one act() would hold every render until its end.
    for (let second = 0; second < 64; second++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    expect(list.mock.calls.length).toBeGreaterThan(quiet + 5);
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it('uses the single server snapshot instead of independently joining registry and profiles', async () => {
  const snapshot = vi.fn().mockResolvedValue({
    rows: [{ catalogId: 'one', profile: { version: 2 } }],
    invalidRowCount: 1
  });
  const catalogs = vi.fn();
  const profiles = vi.fn();
  const client = {
    listCatalogManagerSnapshot: snapshot,
    listTeamProductCatalogs: catalogs,
    listCatalogUpdateProfiles: profiles
  } as unknown as CatalogUpdaterClient;
  const hook = renderHook(() => useCatalogRegistry('team', true, client));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(catalogs).not.toHaveBeenCalled();
  expect(profiles).not.toHaveBeenCalled();
  expect(hook.result.current.rows?.[0].profile?.version).toBe(2);
  expect(hook.result.current.invalidRowCount).toBe(1);
});
