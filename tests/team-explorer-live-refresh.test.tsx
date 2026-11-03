// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSearchResponse, FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ExplorerProvider, useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { useCatalogSearch } from '../apps/web/src/team/catalog/useCatalogSearch';
import { useVisibleRowAnchor } from '../apps/web/src/team/explorer/useVisibleRowAnchor';
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
  it('settles a strict reload after its fresh read while indexing continues', async () => {
    const pending: Array<(page: FolderPage) => void> = [];
    const client = {
      listFolderPage: vi.fn(() => new Promise<FolderPage>(resolve => pending.push(resolve)))
    };
    const view = renderHook(
      ({ revision }) =>
        useFolderPage({ teamId, client, parentFolderId: 'root', revision, preserveOnEmpty: true }),
      { initialProps: { revision: 0 } }
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    let settled = false;
    let strict!: Promise<void>;
    act(() => {
      strict = view.result.current.reloadStrict().then(() => {
        settled = true;
      });
      void strict.catch(() => {});
    });
    await act(async () => {
      pending[0]!({ rows: [row(1)], total: 1, next: null });
    });
    expect(pending).toHaveLength(2);
    view.rerender({ revision: 1 });
    await act(async () => {
      pending[1]!({ rows: [row(2)], total: 1, next: null });
    });
    expect(pending).toHaveLength(3);
    expect(view.result.current.rows[0]?.id).toBe('id-2');
    expect(settled).toBe(true);
    await strict;
    await act(async () => {
      pending[2]!({ rows: [], total: 0, next: null });
    });
    expect(view.result.current.rows[0]?.id).toBe('id-2');
  });

  it('reports a shared read failure only to strict callers, while background reloads settle safely', async () => {
    let fail!: (cause: Error) => void;
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
        .mockImplementationOnce(
          () =>
            new Promise<FolderPage>((_resolve, reject) => {
              fail = reject;
            })
        )
        .mockRejectedValue(new Error('temporary'))
    };
    const view = renderHook(() => useFolderPage({ teamId, client, parentFolderId: 'root' }));
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    let strict!: Promise<string | void>;
    act(() => {
      strict = view.result.current.reloadStrict().catch(error => error.message);
    });
    await waitFor(() => expect(client.listFolderPage).toHaveBeenCalledTimes(2));
    let background!: Promise<string>;
    act(() => {
      background = view.result.current.reload().then(
        () => 'resolved',
        () => 'rejected'
      );
    });
    await act(async () => {
      fail(new Error('temporary'));
      expect(await strict).toBe('FOLDER_PAGE_REFRESH_FAILED');
      expect(await background).toBe('resolved');
    });
    expect(view.result.current.error).toBe(true);
    expect(view.result.current.rows[0]?.id).toBe('id-1');
  });

  it('settles a superseded strict refresh with the newer successful read', async () => {
    let release!: (value: FolderPage) => void;
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
        .mockImplementationOnce(
          () =>
            new Promise<FolderPage>(resolve => {
              release = resolve;
            })
        )
        .mockResolvedValue({ rows: [row(3)], total: 1, next: null })
    };
    const view = renderHook(() => useFolderPage({ teamId, client, parentFolderId: 'root' }));
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    let strict!: Promise<void>;
    act(() => {
      strict = view.result.current.reloadStrict();
    });
    await waitFor(() => expect(client.listFolderPage).toHaveBeenCalledTimes(2));
    let background!: Promise<void>;
    act(() => {
      background = view.result.current.reload();
    });
    await act(async () => {
      await Promise.resolve();
      release({ rows: [row(2)], total: 1, next: null });
      await expect(strict).resolves.toBeUndefined();
      await background;
    });
    expect(view.result.current.rows[0]?.id).toBe('id-3');
  });
  it('waits for a replacement paint when a local patch supersedes the confirming read', async () => {
    const pending: Array<(page: FolderPage) => void> = [];
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
        .mockImplementation(() => new Promise<FolderPage>(resolve => pending.push(resolve)))
    };
    const view = renderHook(() => useFolderPage({ teamId, client, parentFolderId: 'root' }));
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    let outcome: string | undefined;
    let strict!: Promise<void>;
    act(() => {
      strict = view.result.current.reloadStrict();
      void strict.then(
        () => {
          outcome = 'ok';
        },
        error => {
          outcome = error.message;
        }
      );
    });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => view.result.current.patchRow('id-1', { name: 'confirmed local patch' }));
    await act(async () => {
      pending[0]!({ rows: [row(2)], total: 1, next: null });
    });
    expect(pending).toHaveLength(2);
    expect(outcome).toBeUndefined();
    await act(async () => {
      pending[1]!({ rows: [row(3)], total: 1, next: null });
      await strict;
    });
    expect(outcome).toBe('ok');
    expect(view.result.current.rows[0]?.id).toBe('id-3');
  });

  it('keeps strict empty confirmation across a queued background refresh', async () => {
    let release!: (value: FolderPage) => void;
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
        .mockImplementationOnce(
          () =>
            new Promise<FolderPage>(resolve => {
              release = resolve;
            })
        )
        .mockResolvedValue({ rows: [], total: 0, next: null })
    };
    const view = renderHook(() =>
      useFolderPage({ teamId, client, parentFolderId: 'root', preserveOnEmpty: true })
    );
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    let strict!: Promise<void>;
    act(() => {
      strict = view.result.current.reloadStrict();
    });
    await waitFor(() => expect(client.listFolderPage).toHaveBeenCalledTimes(2));
    let background!: Promise<void>;
    act(() => {
      background = view.result.current.reload();
    });
    await act(async () => {
      await Promise.resolve();
      release({ rows: [], total: 0, next: null });
      await strict;
      await background;
    });
    expect(view.result.current.rows).toEqual([]);
    expect(view.result.current.total).toBe(0);
  });

  it('rejects strict confirmation on unmount even if transport ignores abort', async () => {
    const client = {
      listFolderPage: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
        .mockImplementationOnce(() => new Promise<FolderPage>(() => {}))
    };
    const view = renderHook(() => useFolderPage({ teamId, client, parentFolderId: 'root' }));
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    let pending!: Promise<unknown>;
    act(() => {
      pending = view.result.current.reloadStrict().catch(error => error.message);
    });
    await waitFor(() => expect(client.listFolderPage).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(await pending).toBe('CATALOG_REFRESH_SUPERSEDED');
  });

  it('ignores a search response from the previous team', async () => {
    let releaseOld!: (value: CatalogSearchResponse) => void;
    const old = new Promise<CatalogSearchResponse>(resolve => {
      releaseOld = resolve;
    });
    const resultFor = (total: number): CatalogSearchResponse => ({
      items: [],
      total,
      activeFilters: {},
      facets: { geo: [], language: [], offer: [], category: [] },
      catalogFreshness: freshnessStub({ lastSyncedAt: null })
    });
    const client = {
      searchCatalog: vi.fn((id: string) =>
        id === 'team-old' ? old : Promise.resolve(resultFor(2))
      ),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      })
    };
    const view = renderHook(({ id }) => useCatalogSearch({ teamId: id, client, debounceMs: 0 }), {
      initialProps: { id: 'team-old' },
      wrapper: ({ children }) => <TeamProvider realtime={false}>{children}</TeamProvider>
    });
    await waitFor(() =>
      expect(client.searchCatalog).toHaveBeenCalledWith(
        'team-old',
        expect.anything(),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    view.rerender({ id: 'team-new' });
    await waitFor(() => expect(view.result.current.result?.total).toBe(2));
    await act(async () => releaseOld(resultFor(1)));
    expect(view.result.current.result?.total).toBe(2);
  });

  it('keeps the loaded rows during a transient refresh failure and retries the window', async () => {
    let releaseRetry!: (page: FolderPage) => void;
    const retry = new Promise<FolderPage>(resolve => {
      releaseRetry = resolve;
    });
    const listFolderPage = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockReturnValueOnce(retry);
    const client = { listFolderPage };
    const { result, rerender } = renderHook(
      ({ revision }) => useFolderPage({ teamId, client, parentFolderId: 'root', revision }),
      { initialProps: { revision: 0 } }
    );
    await waitFor(() => expect(result.current.rows.map(item => item.id)).toEqual(['id-1']));
    rerender({ revision: 1 });
    await waitFor(() => expect(listFolderPage).toHaveBeenCalledTimes(3));
    expect(result.current.rows.map(item => item.id)).toEqual(['id-1']);
    await act(async () => releaseRetry({ rows: [row(2)], total: 1, next: null }));
    expect(result.current.rows.map(item => item.id)).toEqual(['id-2']);
    expect(result.current.error).toBe(false);
  });

  it('rejects an older refresh response after a newer revision lands', async () => {
    let releaseOld!: (page: FolderPage) => void;
    const old = new Promise<FolderPage>(resolve => {
      releaseOld = resolve;
    });
    const listFolderPage = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row(1)], total: 1, next: null })
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ rows: [row(3)], total: 1, next: null });
    const client = { listFolderPage };
    const { result, rerender } = renderHook(
      ({ revision }) => useFolderPage({ teamId, client, parentFolderId: 'root', revision }),
      { initialProps: { revision: 0 } }
    );
    await waitFor(() => expect(result.current.rows[0]?.id).toBe('id-1'));
    rerender({ revision: 1 });
    await waitFor(() => expect(listFolderPage).toHaveBeenCalledTimes(2));
    rerender({ revision: 2 });
    expect(listFolderPage).toHaveBeenCalledTimes(2);
    await act(async () => releaseOld({ rows: [row(2)], total: 1, next: null }));
    await waitFor(() => expect(result.current.rows[0]?.id).toBe('id-3'));
    expect(result.current.rows[0]?.id).toBe('id-3');
  });

  it('keeps the first visible material at the same pixel after rows are inserted above it', () => {
    const RectList = ({ ids }: { ids: string[] }) => {
      const ref = React.useRef<HTMLDivElement>(null);
      const capture = useVisibleRowAnchor(ref, ids, 'team-1|root|list');
      return (
        <>
          <button onClick={capture}>Capture</button>
          <div data-testid="scroller" style={{ overflowY: 'auto' }}>
            <div ref={ref}>
              {ids.map(id => (
                <div key={id} data-material-id={id} />
              ))}
            </div>
          </div>
        </>
      );
    };
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const element = this as HTMLElement;
      if (!element.dataset.materialId) return rect(0, 100);
      const scroller = element.closest('[data-testid="scroller"]') as HTMLElement;
      const siblings = Array.from(element.parentElement!.children);
      const top = siblings.indexOf(element) * 20 - scroller.scrollTop;
      return rect(top, top + 20);
    });
    const ids = Array.from({ length: 30 }, (_, index) => `id-${index}`);
    const view = render(<RectList ids={ids} />);
    const scroller = view.getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    scroller.scrollTop = 200;
    fireEvent.click(view.getByRole('button', { name: 'Capture' }));
    view.rerender(<RectList ids={['new', ...ids]} />);
    expect(scroller.scrollTop).toBe(220);
    expect(
      view.container.querySelector('[data-material-id="id-10"]')?.getBoundingClientRect().top
    ).toBe(0);
  });

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
        expect.objectContaining({ page: 3 }),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    const reads = client.searchCatalog.mock.calls.length;
    act(() => result.current.team.notifyStateChanged());
    await waitFor(() => expect(client.searchCatalog).toHaveBeenCalledTimes(reads + 1));
    expect(client.searchCatalog).toHaveBeenLastCalledWith(
      activeTeam,
      expect.objectContaining({ page: 3 }),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
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
    const beforeRowsReplace = vi.fn();
    const { result, rerender } = renderHook(
      ({ revision }) => ({
        page: useFolderPage({
          teamId,
          client,
          parentFolderId: 'root',
          revision,
          beforeRowsReplace
        }),
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
    expect(beforeRowsReplace).toHaveBeenCalledTimes(2);
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
