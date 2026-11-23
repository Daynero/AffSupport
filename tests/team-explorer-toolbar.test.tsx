// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type FolderPage,
  type TeamMaterialRow
} from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { fitFor } from '../apps/web/src/team/explorer/useToolbarFit';
import { emptyTeamRouteQuery, type TeamRouteQuery } from '../apps/web/src/team/routes';
import { makeTeam } from './team-space-fixtures';

/**
 * The explorer's one-row toolbar (070, US1): one primary, the rare work in "…", and what does
 * not fit moving into "…" with its name rather than becoming an unnamed icon.
 */

const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });

function makeClient(rows: TeamMaterialRow[] = []): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows,
      total: rows.length,
      next: null
    })),
    mintThumbnailSession: vi.fn(),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

/** The shell with the address's folder held as the workspace holds it: a folder opened in the
 *  explorer becomes the folder shown. */
function StatefulExplorer({
  client,
  query,
  onQueryChange,
  readOnly,
  retryGroupId
}: {
  client: ExplorerShellClient;
  query: Partial<TeamRouteQuery>;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  readOnly: boolean;
  retryGroupId: string | null;
}) {
  const [folderId, setFolderId] = React.useState<string | null>(query.folderId ?? null);
  return (
    <ExplorerShell
      teamId={team.id}
      client={client}
      query={{ ...emptyTeamRouteQuery(), view: 'list', ...query, folderId }}
      onQueryChange={onQueryChange}
      onFolderChange={setFolderId}
      onSearched={vi.fn()}
      onPreview={vi.fn()}
      readOnly={readOnly}
      retryGroupId={retryGroupId}
      onRetryComplete={vi.fn()}
    />
  );
}

function renderExplorer({
  client = makeClient(),
  query = {},
  onQueryChange = vi.fn(),
  readOnly = false,
  retryGroupId = null
}: {
  client?: ExplorerShellClient;
  query?: Partial<TeamRouteQuery>;
  onQueryChange?: (patch: Partial<TeamRouteQuery>) => void;
  readOnly?: boolean;
  retryGroupId?: string | null;
} = {}) {
  return render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        <StatefulExplorer
          client={client}
          query={query}
          onQueryChange={onQueryChange}
          readOnly={readOnly}
          retryGroupId={retryGroupId}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

/** Lays the toolbar out at `width` pixels; jsdom lays nothing out on its own. */
function toolbarWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('team-explorer-toolbar') ? width : 0;
  });
}

beforeEach(() => localStorage.setItem('wishly.active-team.v1', team.id));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('how much of the toolbar fits (T014)', () => {
  it('steps down from the search box to the magnifier, then the view, then the arrows', () => {
    expect(fitFor(0)).toBe('full');
    expect(fitFor(1016)).toBe('full');
    expect(fitFor(694)).toBe('compact');
    expect(fitFor(500)).toBe('narrow');
    expect(fitFor(294)).toBe('tight');
    // Controls that are there only sometimes take their room from the steps.
    expect(fitFor(800, 128)).toBe('compact');
  });

  it('shows everything on a wide row, with one primary', async () => {
    toolbarWidth(1016);
    renderExplorer();
    const bar = document.querySelector<HTMLElement>('.team-explorer-toolbar')!;
    await waitFor(() => expect(bar.dataset.fit).toBe('full'));
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous folder' })).toBeTruthy();
    expect(within(bar).getByRole('radiogroup', { name: 'View' })).toBeTruthy();
    expect(
      bar.querySelectorAll('.ui-color-primary:is(.ui-button--solid, .ui-icon-button--solid)')
    ).toHaveLength(1);
  });

  it('moves what does not fit into "…", in words, on a phone', async () => {
    toolbarWidth(294);
    renderExplorer();
    const bar = document.querySelector<HTMLElement>('.team-explorer-toolbar')!;
    await waitFor(() => expect(bar.dataset.fit).toBe('tight'));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous folder' })).toBeNull();
    expect(within(bar).queryByRole('radiogroup')).toBeNull();
    // The primary keeps its colour and its name; every icon left in the row has a name.
    expect(within(bar).getByRole('button', { name: 'Upload' })).toBeTruthy();
    for (const button of within(bar).getAllByRole('button')) {
      expect(button.getAttribute('aria-label') ?? button.textContent?.trim()).toBeTruthy();
    }
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions' }));
    const names = (await screen.findAllByRole('menuitem', {}, { timeout: 2000 }))
      .concat(screen.queryAllByRole('menuitemradio'))
      .map(item => item.textContent?.replace('✓', '').trim());
    expect(names).toEqual(expect.arrayContaining(['Search files', 'List', 'Tiles', 'Trash']));
  });
});

describe('the way back and what is true about the folder (T015)', () => {
  it('puts the way back to the task in the path group, as a link', async () => {
    renderExplorer({ query: { back: 'task-7' } });
    const link = await screen.findByRole('link', { name: 'To the task' });
    expect(link.getAttribute('href')).toContain('task-7');
    expect(link.closest('.team-explorer-location')).toBeTruthy();
    expect(link.className).toContain('ui-link--standalone');
  });

  it('says «view only» as an inventory alert over the list, with no way to change anything', async () => {
    renderExplorer({ readOnly: true });
    const note = (await screen.findByText('View only')).closest('.ui-alert')!;
    expect(note).toBeTruthy();
    expect(note.closest('.team-explorer-list-header')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('turns the retry notice into an alert whose action is choosing the files again', async () => {
    renderExplorer({ retryGroupId: 'retry-me' });
    const note = (await screen.findByText('The upload stopped')).closest('.ui-alert')!;
    expect(within(note as HTMLElement).getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: 'Choose again' }));
    expect((await screen.findAllByRole('menuitem')).map(item => item.textContent?.trim())).toEqual([
      'Files…',
      'Folder…',
      'New folder'
    ]);
  });
});

function fileRow(index: number, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: team.id,
    name: `file-${index}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 100 * index,
    kind: 'image',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: `2026-11-0${index}T10:00:00Z`,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false,
    ...overrides
  } as TeamMaterialRow;
}

const names = () =>
  Array.from(document.querySelectorAll('.team-explorer-row .team-explorer-row-open')).map(
    node => node.textContent
  );
const header = (name: string) => screen.getByRole('columnheader', { name });

describe('the list headers sort (T016)', () => {
  it('sorts by a column on a press, turns it on the next, and says so with aria-sort', async () => {
    localStorage.removeItem('soty.team.explorer.sort');
    renderExplorer({ client: makeClient([fileRow(2), fileRow(1), fileRow(3)]) });
    await screen.findByText('file-1.png');
    expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
    expect(header('Last modified').getAttribute('aria-sort')).toBeNull();
    expect(names()).toEqual(['file-1.png', 'file-2.png', 'file-3.png']);

    // A date starts newest first, as Finder's does.
    fireEvent.click(within(header('Last modified')).getByRole('button', { name: 'Last modified' }));
    expect(header('Last modified').getAttribute('aria-sort')).toBe('descending');
    expect(header('Name').getAttribute('aria-sort')).toBeNull();
    expect(names()).toEqual(['file-3.png', 'file-2.png', 'file-1.png']);

    fireEvent.click(within(header('Last modified')).getByRole('button', { name: 'Last modified' }));
    expect(header('Last modified').getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['file-1.png', 'file-2.png', 'file-3.png']);

    // The order is the menu's own: remembered as the menu remembers it.
    expect(JSON.parse(localStorage.getItem('soty.team.explorer.sort')!)).toMatchObject({
      key: 'modified',
      direction: 'asc'
    });
  });

  it('is reachable from the keyboard: the header is a button', async () => {
    renderExplorer({ client: makeClient([fileRow(1), fileRow(2)]) });
    await screen.findByText('file-1.png');
    const size = within(header('Size')).getByRole('button', { name: 'Size' });
    size.focus();
    expect(document.activeElement).toBe(size);
    fireEvent.click(size);
    expect(header('Size').getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual(['file-2.png', 'file-1.png']);
  });

  it('leaves the sort menu to the grid, where there are no headers', async () => {
    renderExplorer({ client: makeClient([fileRow(1)]) });
    await screen.findByText('file-1.png');
    expect(document.querySelector('.team-explorer-list-controls .team-explorer-sort')).toBeNull();
    cleanup();
    renderExplorer({ client: makeClient([fileRow(1)]), query: { view: 'grid' } });
    await screen.findAllByText('file-1.png');
    expect(document.querySelector('.team-explorer-list-controls .team-explorer-sort')).toBeTruthy();
  });
});

function stubNarrow(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: narrow && query.includes('max-width: 1024px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }) as unknown as MediaQueryList
  );
}

describe('the folder tree is a column with an edge, or a drawer (T017)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves its edge from the keyboard within 200–480 px and keeps the width for the space', async () => {
    renderExplorer();
    const edge = await screen.findByRole('separator', { name: 'Folder tree width' });
    const surface = document.querySelector<HTMLElement>('.team-explorer')!;
    expect(edge.getAttribute('aria-valuenow')).toBe('280');
    expect(edge.getAttribute('aria-valuemin')).toBe('200');
    expect(edge.getAttribute('aria-valuemax')).toBe('480');
    expect(surface.style.getPropertyValue('--explorer-tree-width')).toBe('280px');

    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(edge.getAttribute('aria-valuenow')).toBe('296');
    fireEvent.keyDown(edge, { key: 'End' });
    expect(edge.getAttribute('aria-valuenow')).toBe('480');
    expect(surface.style.getPropertyValue('--explorer-tree-width')).toBe('480px');

    // A reload reads it back; a value from outside the bounds is not trusted.
    cleanup();
    renderExplorer();
    expect(
      (await screen.findByRole('separator', { name: 'Folder tree width' })).getAttribute(
        'aria-valuenow'
      )
    ).toBe('480');
    cleanup();
    localStorage.setItem(`soty.team-view.v1:${team.id}:explorer.treeWidth`, '9000');
    renderExplorer();
    expect(
      (await screen.findByRole('separator', { name: 'Folder tree width' })).getAttribute(
        'aria-valuenow'
      )
    ).toBe('280');
  });

  it('is a drawer up to 1024 px, with no edge, that closes when a folder is chosen', async () => {
    stubNarrow(true);
    const client = makeClient();
    (client.listFolderTree as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'folder-1',
        driveFileId: 'drive-folder-1',
        parentFolderId: 'root',
        selectionId: null,
        name: 'Creatives',
        indexedAt: '2026-11-01T00:00:00Z',
        childFolderCount: 0,
        childFileCount: 0,
        thumbnailReadyCount: 0
      }
    ]);
    renderExplorer({ client });
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Folders' }));
    const drawer = await screen.findByRole('dialog', { name: 'Folders' });
    fireEvent.click(await within(drawer).findByRole('button', { name: /Creatives/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Folders' })).toBeNull());
  });
});
