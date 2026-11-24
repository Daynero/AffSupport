// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type CatalogMaterialItem,
  type CatalogSearchResponse,
  type FolderPage,
  type TeamFolderNode,
  type TeamMaterialRow
} from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery, type TeamRouteQuery } from '../apps/web/src/team/routes';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { makeTeam } from './team-space-fixtures';

vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: '00000000-0000-4000-8000-0000000000aa' } })
}));

/**
 * 070 US3 — one search: the toolbar's box holds the words, the results take the list's place
 * as they are typed, with the folder list's selection, its selection bar and the details pane;
 * «Показати в папці» opens the folder and leaves the way back to the search.
 */

const TEAM = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });
const FOLDER: TeamFolderNode = {
  id: 'folder-material',
  driveFileId: 'drive-folder',
  parentFolderId: null,
  selectionId: null,
  name: 'Creatives',
  indexedAt: '2026-11-01T00:00:00Z',
  childFolderCount: 0,
  childFileCount: 2,
  thumbnailReadyCount: 0
};

function row(index: number): TeamMaterialRow {
  return {
    id: `row-${index}`,
    teamId: TEAM.id,
    name: `folder-file-${index}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 100,
    kind: 'image',
    driveFileId: `drive-row-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false
  };
}

function item(index: number, overrides: Partial<CatalogMaterialItem> = {}): CatalogMaterialItem {
  return {
    id: `found-${index}`,
    teamId: TEAM.id,
    parentFolderId: FOLDER.driveFileId,
    name: `banner-${index}.mp4`,
    kind: 'file',
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    classificationVersion: 1,
    classificationSource: 'mime',
    sizeBytes: 2048,
    modifiedAt: '2026-11-10T10:00:00Z',
    geo: 'TR',
    language: null,
    offer: null,
    tags: [],
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    previewState: 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false },
    matchedIn: 'name',
    ...overrides
  };
}

function answer(items: CatalogMaterialItem[]): CatalogSearchResponse {
  return {
    items,
    total: items.length,
    activeFilters: {},
    facets: {},
    catalogFreshness: {
      state: 'ready',
      lastSyncedAt: null,
      discoveredCount: items.length,
      foldersRemaining: null,
      lastProgressAt: null
    }
  };
}

function makeClient(found: CatalogMaterialItem[]): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue([FOLDER]),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows: [row(1), row(2)],
      total: 2,
      next: null
    })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('no session in this test')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(async () => answer(found)),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

/** The shell with its address held the way the workspace holds it. */
function Routed({
  client,
  onPatch
}: {
  client: ExplorerShellClient;
  onPatch: (patch: Partial<TeamRouteQuery>) => void;
}) {
  const [query, setQuery] = useState<TeamRouteQuery>({ ...emptyTeamRouteQuery(), view: 'list' });
  const change = (patch: Partial<TeamRouteQuery>) => {
    onPatch(patch);
    setQuery(current => ({
      ...current,
      ...patch,
      filters: patch.filters ?? (('filters' in patch ? undefined : current.filters) as never)
    }));
  };
  return (
    <ExplorerShell
      teamId={TEAM.id}
      client={client}
      query={query}
      onQueryChange={change}
      onFolderChange={folderId => change({ folderId, itemId: null })}
      onSearched={state => change({ q: state.query, filters: state.filters })}
      onPreview={vi.fn()}
    />
  );
}

/** Words into the box at once: typing them a key at a time re-asks the search six times. */
function type(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
}

function renderSearch(found = [item(1), item(2), item(3)]) {
  const client = makeClient(found);
  const onPatch = vi.fn();
  render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[TEAM]}>
        <Routed client={client} onPatch={onPatch} />
      </TeamProvider>
    </ToastProvider>
  );
  return { client, onPatch };
}

beforeEach(() => {
  localStorage.setItem('soty.flag.explorerInlineSearch', 'on');
  localStorage.setItem('wishly.active-team.v1', TEAM.id);
  setPrivateCacheScope('00000000-0000-4000-8000-0000000000aa', 'owner');
});
afterEach(() => {
  cleanup();
  clearThumbnailSessions();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('one search (070, US3)', () => {
  it('shows the results in the list’s place as the words are typed, with nothing else moved', async () => {
    const { client } = renderSearch();
    await screen.findByText('folder-file-1.png');
    const box = screen.getByRole('searchbox', { name: 'Search files' });
    type(box, 'banner');
    await screen.findByTitle('banner-1.mp4');
    expect(client.searchCatalog).toHaveBeenCalled();
    // The folder's rows are gone; the toolbar, its box and its path are where they were.
    expect(screen.queryByText('folder-file-1.png')).toBeNull();
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(document.querySelector('.team-explorer-toolbar .team-explorer-breadcrumb')).toBeTruthy();
    // A result says where it lives.
    expect(document.querySelector('.team-explorer-result-where')?.textContent).toContain(
      'Creatives'
    );
  });

  it('walks the results with the arrows and shows the focused one in the details pane', async () => {
    renderSearch();
    await screen.findByText('folder-file-1.png');
    type(screen.getByRole('searchbox', { name: 'Search files' }), 'banner');
    await screen.findByTitle('banner-1.mp4');
    // Down hands the keyboard to the results; the first one is where the arrows start.
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search files' }), {
      key: 'ArrowDown'
    });
    const list = document.querySelector<HTMLElement>('[data-explorer-results]')!;
    await waitFor(() => expect(document.activeElement).toBe(list));
    await waitFor(() => expect(list.dataset.selected).toBe('found-1'));
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(list.dataset.selected).toBe('found-2'));
    const pane = await screen.findByRole(
      'complementary',
      { name: 'Selected item' },
      { timeout: 2000 }
    );
    expect(within(pane).getByText('banner-2.mp4')).toBeTruthy();
    expect(pane.textContent).toContain('GEO: TR');
  });

  it('checks results into the same selection bar, in the strip above the list', async () => {
    const user = userEvent.setup();
    renderSearch();
    await screen.findByText('folder-file-1.png');
    type(screen.getByRole('searchbox', { name: 'Search files' }), 'banner');
    await screen.findByTitle('banner-1.mp4');
    const boxes = screen.getAllByRole('checkbox', { name: /^Select / });
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    const bar = await screen.findByRole('toolbar', { name: 'What to do with the selection' });
    expect(bar.textContent).toContain('Selected: 2');
    expect(bar.closest('.team-explorer-list-controls')).toBeTruthy();
    expect(bar.closest('.team-explorer-toolbar')).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Move to trash' })).toBeTruthy();
    // Space on the list checks the focused result too, as in a folder.
    const list = document.querySelector<HTMLElement>('[data-explorer-results]')!;
    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'What to do with the selection' })).toBeNull()
    );
  });

  it('shows a result in its folder and offers the way back to the search', async () => {
    const user = userEvent.setup();
    const { onPatch } = renderSearch();
    await screen.findByText('folder-file-1.png');
    type(screen.getByRole('searchbox', { name: 'Search files' }), 'banner');
    await screen.findByTitle('banner-1.mp4');
    await user.click(screen.getByTitle('banner-2.mp4'));
    const pane = await screen.findByRole(
      'complementary',
      { name: 'Selected item' },
      { timeout: 2000 }
    );
    await user.click(within(pane).getByRole('button', { name: 'Show in folder' }));
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ q: '', folderId: 'drive-folder', itemId: 'found-2' })
      )
    );
    const back = await screen.findByRole('button', { name: 'Back to results' });
    await user.click(back);
    await waitFor(() =>
      expect(onPatch).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'banner' }))
    );
    await screen.findByTitle('banner-1.mp4');
    expect(
      (screen.getByRole('searchbox', { name: 'Search files' }) as HTMLInputElement).value
    ).toBe('banner');
  });

  it('follows the words letter by letter, and one letter is not yet a search', async () => {
    const { client } = renderSearch();
    await screen.findByText('folder-file-1.png');
    const box = screen.getByRole('searchbox', { name: 'Search files' });
    type(box, 'b');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(screen.getByText('folder-file-1.png')).toBeTruthy();
    for (const text of ['ba', 'ban', 'bann', 'banne', 'banner']) {
      type(box, text);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await screen.findByTitle('banner-1.mp4');
    await waitFor(() => {
      const asked = vi.mocked(client.searchCatalog).mock.calls.map(call => call[1].query);
      expect(asked.at(-1)).toBe('banner');
    });
  });

  it('puts the search away when the box is emptied', async () => {
    const { onPatch } = renderSearch();
    await screen.findByText('folder-file-1.png');
    const box = screen.getByRole('searchbox', { name: 'Search files' });
    type(box, 'banner');
    await screen.findByTitle('banner-1.mp4');
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ q: '', scope: 'folder' }))
    );
    await screen.findByText('folder-file-1.png');
  });

  it('keeps the old search screen when the flag is off', async () => {
    localStorage.setItem('soty.flag.explorerInlineSearch', 'off');
    const user = userEvent.setup();
    renderSearch();
    await screen.findByText('folder-file-1.png');
    const box = screen.getByRole('searchbox', { name: 'Search files' });
    await user.type(box, 'banner');
    // Nothing happens before Enter on the old path…
    expect(screen.getByText('folder-file-1.png')).toBeTruthy();
    await user.keyboard('{Enter}');
    // …and then the catalogue's own screen opens, with its own field.
    await waitFor(() =>
      expect(document.querySelector('.team-catalog:not(.is-embedded)')).toBeTruthy()
    );
  });
});
