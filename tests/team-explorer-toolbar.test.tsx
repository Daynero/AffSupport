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

export function renderExplorer({
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
        <ExplorerShell
          teamId={team.id}
          client={client}
          query={{ ...emptyTeamRouteQuery(), view: 'list', ...query }}
          onQueryChange={onQueryChange}
          onFolderChange={vi.fn()}
          onSearched={vi.fn()}
          onPreview={vi.fn()}
          readOnly={readOnly}
          retryGroupId={retryGroupId}
          onRetryComplete={vi.fn()}
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
