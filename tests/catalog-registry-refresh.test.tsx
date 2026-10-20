// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const context = vi.hoisted(() => ({ revision: 42 }));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => context }));
import {
  useCatalogRegistry,
  type CatalogUpdaterClient
} from '../apps/web/src/team/catalog-updater/useCatalogUpdater';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('catalog registry first read', () => {
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
