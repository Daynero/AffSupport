// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ExplorerProvider, useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { useCatalogSearch } from '../apps/web/src/team/catalog/useCatalogSearch';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { freshnessStub } from './support/catalog-stub.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const teamId = 'team-1';
const row = (index: number): TeamMaterialRow => ({
  id: `id-${index}`,
  teamId,
  name: `file-${index}.png`,
  category: 'image',
  mimeType: 'image/png',
  fileExtension: 'png',
  sizeBytes: index,
  kind: 'image',
  driveFileId: `drive-${index}`,
  parentFolderId: 'root',
  modifiedAt: null,
  driveVersion: '1',
  previewState: 'pending',
  thumbnailReady: false
});

describe('visible explorer window refresh', () => {
  it('keeps the active search page when the team revision changes', async () => {
    const activeTeam = '22000000-0000-4000-8000-000000000001';
    localStorage.setItem('wishly.active-team.v1', activeTeam);
    const client = {
      searchCatalog: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        activeFilters: {},
        facets: { geo: [], language: [], offer: [], category: [] },
        catalogFreshness: freshnessStub({ lastSyncedAt: null })
      }),
      getCatalogVocabulary: vi
        .fn()
        .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] })
    };
    const { result } = renderHook(
      () => ({
        search: useCatalogSearch({ teamId: activeTeam, client, debounceMs: 0 }),
        team: useTeam()
      }),
      {
        wrapper: ({ children }) => (
          <TeamProvider
            realtime={false}
            initialTeams={[
              {
                id: activeTeam,
                name: 'Team',
                role: 'owner',
                permissions: DEFAULT_ROLE_PERMISSIONS.owner,
                connectionState: 'connected'
              }
            ]}
          >
            {children}
          </TeamProvider>
        )
      }
    );
    await waitFor(() => expect(client.searchCatalog).toHaveBeenCalled());
    act(() => result.current.search.setPage(3));
    await waitFor(() =>
      expect(client.searchCatalog).toHaveBeenLastCalledWith(
        activeTeam,
        expect.objectContaining({ page: 3 })
      )
    );
    const reads = client.searchCatalog.mock.calls.length;
    act(() => result.current.team.notifyStateChanged());
    await waitFor(() => expect(client.searchCatalog).toHaveBeenCalledTimes(reads + 1));
    expect(client.searchCatalog).toHaveBeenLastCalledWith(
      activeTeam,
      expect.objectContaining({ page: 3 })
    );
    expect(result.current.search.page).toBe(3);
  });

  it('keeps loaded pages, an existing anchor and selection after a live revision', async () => {
    const inventory = Array.from({ length: 230 }, (_, index) => row(index));
    const listFolderPage = vi.fn(
      async (_team: string, input: { after?: { id: string } | null }): Promise<FolderPage> => {
        const start = input.after
          ? inventory.findIndex(item => item.id === input.after!.id) + 1
          : 0;
        const rows = inventory.slice(start, start + 100);
        const last = rows.at(-1);
        return {
          rows,
          total: inventory.length,
          next:
            last && start + rows.length < inventory.length
              ? { sortKey: last.name, id: last.id }
              : null
        };
      }
    );
    const client = { listFolderPage, listFolderTree: vi.fn().mockResolvedValue([]) };
    const { result, rerender } = renderHook(
      ({ revision }) => ({
        page: useFolderPage({ teamId, client, parentFolderId: 'root', revision }),
        explorer: useExplorer()
      }),
      {
        initialProps: { revision: 0 },
        wrapper: ({ children }) => (
          <ExplorerProvider teamId={teamId} client={client}>
            {children}
          </ExplorerProvider>
        )
      }
    );
    await waitFor(() => expect(result.current.page.rows).toHaveLength(100));
    await act(async () => {
      await result.current.page.loadMore();
    });
    await act(async () => {
      await result.current.page.loadMore();
    });
    expect(result.current.page.rows).toHaveLength(230);
    const anchor = result.current.page.rows.find(item => item.id === 'id-150')!;
    act(() => result.current.explorer.toggleSelected(anchor));
    inventory.unshift(row(-1));
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.page.rows[0]?.id).toBe('id--1'));
    expect(result.current.page.rows).toHaveLength(231);
    expect(result.current.page.rows.some(item => item.id === anchor.id)).toBe(true);
    expect(result.current.explorer.selectedIds.has(anchor.id)).toBe(true);
    expect(listFolderPage.mock.calls.slice(-3).map(call => call[1].after?.id ?? null)).toEqual([
      null,
      'id-98',
      'id-198'
    ]);
  });
});
