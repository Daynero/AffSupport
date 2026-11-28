// @vitest-environment jsdom
import React, { type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { FolderPage, TeamFolderNode, TeamMaterialRow } from '@video-compressor/shared';
import { getSupabaseClient } from '../apps/web/src/lib/supabase';
import { clearSpaceStorageCaches, rememberSpaceBackend } from '../apps/web/src/api/space-storage';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import {
  MemorySpaceCacheStorage,
  SPACE_CACHE_MAX_BYTES,
  SPACE_CACHE_MAX_ENTRIES,
  SPACE_CACHE_MAX_ENTRY_BYTES,
  readSpaceCache,
  retainSpaceCache,
  setSpaceCacheStorage,
  spaceCacheSettled,
  writeSpaceCache,
  type SpaceCacheAddress,
  type SpaceCacheStorage
} from '../apps/web/src/team/storage/spaceCache';
import { useSpaceUsageRevision } from '../apps/web/src/team/storage/spaceSignals';
import { useTeamRealtime } from '../apps/web/src/team/useTeamRealtime';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { ExplorerProvider, useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { useFolderResync } from '../apps/web/src/team/explorer/useFolderResync';
import { useExplorerResync } from '../apps/web/src/team/explorer/useExplorerResync';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { useWakeCatalogSync } from '../apps/web/src/team/useWakeCatalogSync';

/**
 * 057 T048 (FR-037, FR-040, R7, R8): an R2 space follows its own signals and opens from a
 * bounded IndexedDB cache; a Drive space takes none of it.
 */
const auth = vi.hoisted(() => ({ actor: 'actor-a' as string | null }));
vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));
vi.mock('../apps/web/src/auth/AuthContext', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/auth/AuthContext')>()),
  useOptionalAuth: () => (auth.actor ? { user: { id: auth.actor } } : null)
}));
vi.mock('../apps/web/src/team/useWakeCatalogSync', () => ({ useWakeCatalogSync: vi.fn() }));

const R2_TEAM = '57000000-0000-4000-8000-000000000001';
const DRIVE_TEAM = '57000000-0000-4000-8000-000000000002';
const GONE_TEAM = '57000000-0000-4000-8000-000000000003';
const FOLDER = '57000000-0000-4000-8000-0000000000f1';
const OTHER_FOLDER = '57000000-0000-4000-8000-0000000000f2';

type Callback = (payload?: { new?: Record<string, unknown> }) => void;
let events: Map<string, Callback>;
let storage: MemorySpaceCacheStorage;

function row(index: number, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id: `57000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
    teamId: R2_TEAM,
    name: `file-${index}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 100 * index,
    kind: 'image',
    driveFileId: `57000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
    parentFolderId: FOLDER,
    modifiedAt: '2026-11-01T10:00:00Z',
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false,
    ...overrides
  };
}

function node(id: string, name: string): TeamFolderNode {
  return {
    id,
    driveFileId: id,
    parentFolderId: null,
    selectionId: null,
    name,
    indexedAt: '2026-11-01T10:00:00Z',
    childFolderCount: 0,
    childFileCount: 2,
    thumbnailReadyCount: 0
  };
}

function page(rows: TeamMaterialRow[]): FolderPage {
  return { rows, total: rows.length, next: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const pageAddress = (teamId = R2_TEAM, folder: string | null = FOLDER): SpaceCacheAddress => ({
  actorId: 'actor-a',
  teamId,
  kind: 'page',
  scope: JSON.stringify([folder, ''])
});

beforeEach(() => {
  auth.actor = 'actor-a';
  storage = new MemorySpaceCacheStorage();
  setSpaceCacheStorage(storage);
  rememberSpaceBackend(R2_TEAM, 'r2');
  events = new Map();
  const channel = {
    on: vi.fn((_: string, filter: { table: string }, callback: Callback) => {
      events.set(filter.table, callback);
      return channel;
    }),
    subscribe: vi.fn(() => channel)
  };
  vi.mocked(getSupabaseClient).mockReturnValue({
    channel: vi.fn().mockReturnValue(channel),
    removeChannel: vi.fn().mockResolvedValue(undefined)
  } as unknown as ReturnType<typeof getSupabaseClient>);
});

afterEach(async () => {
  cleanup();
  await spaceCacheSettled();
  setSpaceCacheStorage(undefined);
  clearSpaceStorageCaches();
  localStorage.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('R2 space signals', () => {
  it('re-reads the signalled folder in place, without the rows ever leaving the screen', async () => {
    const shown: number[] = [];
    const listFolderPage = vi.fn().mockResolvedValueOnce(page([row(1)]));
    const client = { listFolderPage };
    const onRefetch = vi.fn();
    const view = renderHook(() => {
      useTeamRealtime({ teamId: R2_TEAM, onRefetch, r2: true });
      const result = useFolderPage({ teamId: R2_TEAM, client, parentFolderId: FOLDER });
      shown.push(result.rows.length);
      return result;
    });
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    const signal = events.get('team_space_storage_signals');
    expect(signal).toBeTypeOf('function');

    // Another folder, and the space's use: nothing to read here.
    act(() => signal!({ new: { team_id: R2_TEAM, kind: 'content', folder_id: OTHER_FOLDER } }));
    act(() => signal!({ new: { team_id: R2_TEAM, kind: 'usage', folder_id: null } }));
    expect(listFolderPage).toHaveBeenCalledTimes(1);

    const second = deferred<FolderPage>();
    listFolderPage.mockReturnValueOnce(second.promise);
    const before = shown.length;
    act(() =>
      signal!({ new: { team_id: R2_TEAM, kind: 'content', folder_id: FOLDER, revision: '7' } })
    );
    await waitFor(() => expect(listFolderPage).toHaveBeenCalledTimes(2));
    expect(listFolderPage.mock.calls[1]?.[1]).toMatchObject({ parentFolderId: FOLDER });
    await act(async () => second.resolve(page([row(1), row(2)])));
    await waitFor(() => expect(view.result.current.rows).toHaveLength(2));
    // In place: every render between the signal and the answer still showed the old row.
    expect(shown.slice(before).every(length => length >= 1)).toBe(true);
    // The signal went to the folder, not through the broad catalog read.
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it('a derivative signal without a folder re-reads what is on screen; usage is counted', async () => {
    const listFolderPage = vi.fn().mockResolvedValue(page([row(1)]));
    const client = { listFolderPage };
    const onRefetch = vi.fn();
    const view = renderHook(() => {
      useTeamRealtime({ teamId: R2_TEAM, onRefetch, r2: true });
      return {
        page: useFolderPage({ teamId: R2_TEAM, client, parentFolderId: FOLDER }),
        usage: useSpaceUsageRevision(R2_TEAM)
      };
    });
    await waitFor(() => expect(view.result.current.page.rows).toHaveLength(1));
    const signal = events.get('team_space_storage_signals')!;
    act(() => signal({ new: { team_id: R2_TEAM, kind: 'derivative', folder_id: null } }));
    await waitFor(() => expect(listFolderPage).toHaveBeenCalledTimes(2));
    act(() => signal({ new: { team_id: R2_TEAM, kind: 'usage', folder_id: null } }));
    expect(view.result.current.usage).toBe(1);
    // A row of another space or of an unknown kind is not a signal.
    act(() => signal({ new: { team_id: DRIVE_TEAM, kind: 'content', folder_id: null } }));
    act(() => signal({ new: { team_id: R2_TEAM, kind: 'rename', folder_id: null } }));
    expect(listFolderPage).toHaveBeenCalledTimes(2);
  });

  it('a Drive space does not subscribe to storage signals at all', () => {
    const onRefetch = vi.fn();
    renderHook(() => useTeamRealtime({ teamId: DRIVE_TEAM, onRefetch }));
    expect(events.has('team_space_storage_signals')).toBe(false);
    expect(events.has('team_catalog_events')).toBe(true);
  });
});

describe('R2 space cache', () => {
  it('a warm open paints the cached first page before the network answers', async () => {
    writeSpaceCache(pageAddress(), { rows: [row(1), row(2)], total: 2, next: null, hidden: 0 });
    await spaceCacheSettled();
    const network = deferred<FolderPage>();
    const listFolderPage = vi.fn().mockReturnValue(network.promise);
    const client = { listFolderPage };
    const view = renderHook(() =>
      useFolderPage({ teamId: R2_TEAM, client, parentFolderId: FOLDER })
    );
    await waitFor(() => expect(view.result.current.rows).toHaveLength(2));
    expect(view.result.current.total).toBe(2);
    expect(listFolderPage).toHaveBeenCalledTimes(1);
    // The read that was already running replaces the cache, and is what the next visit opens on.
    await act(async () => network.resolve(page([row(3)])));
    await waitFor(() =>
      expect(view.result.current.rows.map(item => item.name)).toEqual(['file-3.png'])
    );
    await spaceCacheSettled();
    const kept = await readSpaceCache(pageAddress(), value => value as { rows: TeamMaterialRow[] });
    expect(kept?.rows.map(item => item.name)).toEqual(['file-3.png']);
  });

  it('a warm open paints the cached tree, then the read replaces it', async () => {
    const address: SpaceCacheAddress = {
      actorId: 'actor-a',
      teamId: R2_TEAM,
      kind: 'tree',
      scope: ''
    };
    writeSpaceCache(address, [node(FOLDER, 'Cached')]);
    await spaceCacheSettled();
    const network = deferred<TeamFolderNode[]>();
    const client = { listFolderTree: vi.fn().mockReturnValue(network.promise) };
    const view = renderHook(() => useExplorer(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ExplorerProvider teamId={R2_TEAM} client={client}>
          {children}
        </ExplorerProvider>
      )
    });
    await waitFor(() =>
      expect(view.result.current.nodes?.map(item => item.name)).toEqual(['Cached'])
    );
    await act(async () => network.resolve([node(FOLDER, 'Fresh'), node(OTHER_FOLDER, 'New')]));
    await waitFor(() => expect(view.result.current.nodes).toHaveLength(2));
  });

  it('a Drive space neither reads nor writes the cache', async () => {
    const listFolderPage = vi.fn().mockResolvedValue(page([row(1, { teamId: DRIVE_TEAM })]));
    const client = { listFolderPage };
    const view = renderHook(() =>
      useFolderPage({ teamId: DRIVE_TEAM, client, parentFolderId: FOLDER })
    );
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    await spaceCacheSettled();
    expect(storage.records.size).toBe(0);
  });

  it('keeps the LRU inside its entry and byte limits, dropping the least recently used', async () => {
    for (let index = 0; index < SPACE_CACHE_MAX_ENTRIES; index += 1)
      writeSpaceCache({ ...pageAddress(), scope: `folder-${index}` }, { index });
    await spaceCacheSettled();
    // Reading the oldest makes it the newest.
    await readSpaceCache({ ...pageAddress(), scope: 'folder-0' }, value => value);
    for (let index = 0; index < 5; index += 1)
      writeSpaceCache({ ...pageAddress(), scope: `extra-${index}` }, { index });
    await spaceCacheSettled();
    const scopes = [...storage.records.values()].map(record => record.scope);
    expect(scopes).toHaveLength(SPACE_CACHE_MAX_ENTRIES);
    expect(scopes).toContain('folder-0');
    expect(scopes).toContain('extra-4');
    expect(scopes).not.toContain('folder-1');

    // Bytes: a handful of large values cannot grow the store past its byte cap.
    const large = 'x'.repeat(Math.floor(SPACE_CACHE_MAX_ENTRY_BYTES / 2) - 64);
    const count = Math.ceil(SPACE_CACHE_MAX_BYTES / SPACE_CACHE_MAX_ENTRY_BYTES) * 2 + 2;
    for (let index = 0; index < count; index += 1)
      writeSpaceCache({ ...pageAddress(), scope: `large-${index}` }, large);
    await spaceCacheSettled();
    const bytes = [...storage.records.values()].reduce((sum, record) => sum + record.bytes, 0);
    expect(bytes).toBeLessThanOrEqual(SPACE_CACHE_MAX_BYTES);
    expect(
      storage.records.has(JSON.stringify(['actor-a', R2_TEAM, 'page', `large-${count - 1}`]))
    ).toBe(true);

    // A single value over the per-entry cap is not kept at all.
    writeSpaceCache({ ...pageAddress(), scope: 'huge' }, 'x'.repeat(SPACE_CACHE_MAX_ENTRY_BYTES));
    await spaceCacheSettled();
    expect([...storage.records.values()].some(record => record.scope === 'huge')).toBe(false);
  });

  it('a failing storage degrades to no cache, never to a broken page', async () => {
    const broken: SpaceCacheStorage = {
      get: () => Promise.reject(new Error('blocked')),
      put: () => Promise.reject(new Error('blocked')),
      touch: () => Promise.reject(new Error('blocked')),
      index: () => Promise.reject(new Error('blocked')),
      delete: () => Promise.reject(new Error('blocked')),
      clear: () => Promise.reject(new Error('blocked'))
    };
    setSpaceCacheStorage(broken);
    const listFolderPage = vi.fn().mockResolvedValue(page([row(1)]));
    const client = { listFolderPage };
    const view = renderHook(() =>
      useFolderPage({ teamId: R2_TEAM, client, parentFolderId: FOLDER })
    );
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    expect(view.result.current.error).toBe(false);
    await expect(readSpaceCache(pageAddress(), value => value)).resolves.toBeNull();
  });

  it('a malformed record is ignored and dropped', async () => {
    writeSpaceCache(pageAddress(), { rows: [{ id: 1 }], total: 1, next: null, hidden: 0 });
    await spaceCacheSettled();
    const network = deferred<FolderPage>();
    const client = { listFolderPage: vi.fn().mockReturnValue(network.promise) };
    const view = renderHook(() =>
      useFolderPage({
        teamId: R2_TEAM,
        client,
        parentFolderId: FOLDER
      })
    );
    await act(async () => spaceCacheSettled());
    expect(view.result.current.rows).toHaveLength(0);
    expect(storage.records.size).toBe(0);
    await act(async () => network.resolve(page([])));
  });
});

describe('the cache is the account’s and the space’s', () => {
  const seed = async () => {
    writeSpaceCache(pageAddress(R2_TEAM), { rows: [row(1)], total: 1, next: null, hidden: 0 });
    writeSpaceCache(pageAddress(GONE_TEAM), { rows: [row(1)], total: 1, next: null, hidden: 0 });
    writeSpaceCache({ ...pageAddress(R2_TEAM), actorId: 'actor-b' }, { rows: [] });
    await spaceCacheSettled();
  };
  const teams = () =>
    [...storage.records.values()].map(record => `${record.actorId}:${record.teamId}`);

  it('a sign-out empties it; a remount of the same account does not', async () => {
    await seed();
    setPrivateCacheScope('actor-a', 'scope-1');
    // Strict mode, or a provider moving: cleared and set again in one go.
    setPrivateCacheScope(null, '');
    setPrivateCacheScope('actor-a', 'scope-1');
    await Promise.resolve();
    await spaceCacheSettled();
    expect(storage.records.size).toBe(3);

    setPrivateCacheScope(null, '');
    await Promise.resolve();
    await spaceCacheSettled();
    expect(storage.records.size).toBe(0);
  });

  it('a change of account empties it', async () => {
    await seed();
    setPrivateCacheScope('actor-a', 'scope-1');
    setPrivateCacheScope('actor-b', 'scope-2');
    await Promise.resolve();
    await spaceCacheSettled();
    expect(storage.records.size).toBe(0);
    setPrivateCacheScope(null, '');
  });

  it('a revoked space and other accounts go once the space list is confirmed', async () => {
    await seed();
    await retainSpaceCache('actor-a', [R2_TEAM]);
    expect(teams()).toEqual([`actor-a:${R2_TEAM}`]);
  });

  it('the team provider confirms the list, and a space that left it is dropped', async () => {
    await seed();
    const r2: TeamContextSnapshot = {
      id: R2_TEAM,
      name: 'R2',
      role: 'owner',
      permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      connectionState: 'connected',
      storageBackend: 'r2'
    };
    const listTeams = vi.fn(async () => [r2]);
    const client = { listTeams };
    renderHook(() => null, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <TeamProvider client={client} realtime={false}>
          {children}
        </TeamProvider>
      )
    });
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
    await waitFor(async () => {
      await spaceCacheSettled();
      expect(teams()).toEqual([`actor-a:${R2_TEAM}`]);
    });
  });
});

describe('an R2 space has no Drive sync', () => {
  const r2: TeamContextSnapshot = {
    id: R2_TEAM,
    name: 'R2',
    role: 'owner',
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'connected',
    storageBackend: 'r2'
  };
  const drive: TeamContextSnapshot = {
    ...r2,
    id: DRIVE_TEAM,
    name: 'Drive',
    storageBackend: 'drive'
  };

  it('does not wake a catalog feed for an open R2 space, and still does for Drive', async () => {
    for (const [space, expected] of [
      [r2, null],
      [drive, DRIVE_TEAM]
    ] as const) {
      vi.mocked(useWakeCatalogSync).mockClear();
      window.history.replaceState(null, '', `/team/${space.id}`);
      localStorage.setItem('wishly.active-team.v1', space.id);
      const view = renderHook(() => null, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <TeamProvider initialTeams={[space]}>{children}</TeamProvider>
        )
      });
      await act(async () => {});
      expect(vi.mocked(useWakeCatalogSync).mock.calls.at(-1)?.[0]).toBe(expected);
      expect(events.has('team_space_storage_signals')).toBe(space === r2);
      view.unmount();
      events.clear();
    }
  });

  it('resumes no remembered scan, polls nothing and starts nothing', async () => {
    vi.useFakeTimers();
    localStorage.setItem(`soty:folder-resync:${R2_TEAM}:${FOLDER}`, 'job-1');
    const client = {
      resyncFolder: vi.fn(),
      getFolderSyncStatus: vi.fn(),
      cancelFolderSync: vi.fn()
    };
    const view = renderHook(() =>
      useFolderResync({
        teamId: R2_TEAM,
        folderId: FOLDER,
        client,
        onComplete: async () => {},
        onOutcome: vi.fn(),
        enabled: false
      })
    );
    await act(async () => {
      await view.result.current.start();
      await view.result.current.cancel();
    });
    expect(client.getFolderSyncStatus).not.toHaveBeenCalled();
    expect(client.resyncFolder).not.toHaveBeenCalled();
    expect(client.cancelFolderSync).not.toHaveBeenCalled();
    expect(view.result.current.status).toBeNull();
    // Nothing comes back to ask later either.
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(client.getFolderSyncStatus).not.toHaveBeenCalled();
  });

  it('offers no sync control and no status panel', () => {
    localStorage.setItem(`soty:folder-resync:${R2_TEAM}:${FOLDER}`, 'job-1');
    const getFolderSyncStatus = vi.fn(() => new Promise<never>(() => {}));
    const view = renderHook(
      () =>
        useExplorerResync({
          teamId: R2_TEAM,
          client: {
            resyncFolder: vi.fn(),
            resyncDrive: vi.fn(),
            getFolderSyncStatus
          } as never,
          currentFolderId: FOLDER,
          pathTo: () => [],
          nodeOf: () => null,
          readOnly: false,
          role: 'owner',
          workspaceOperations: null,
          notifyStateChanged: vi.fn(),
          // Not told: the space's own backend decides.
          onComplete: async () => {}
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ToastProvider>{children}</ToastProvider>
        )
      }
    );
    expect(view.result.current.canResync).toBe(false);
    expect(view.result.current.folderResync.status).toBeNull();
    expect(view.result.current.folderResync.running).toBe(false);
    expect(getFolderSyncStatus).not.toHaveBeenCalled();
  });
});
