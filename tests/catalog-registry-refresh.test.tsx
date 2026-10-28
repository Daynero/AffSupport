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
    expect(get).toHaveBeenCalledTimes(1);
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
      result.current.reload();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
