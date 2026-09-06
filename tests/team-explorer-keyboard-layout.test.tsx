// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { FolderPage, TeamFolderNode, TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import { makeTeam } from './team-space-fixtures';

/**
 * Feature 011 (T057): the content area under the keyboard — arrows move the
 * focus, Enter opens, Escape clears, space toggles the selection — and the
 * narrow layout keeps the tree behind a toggle rather than dropping it.
 */

afterEach(() => {
  cleanup();
  clearThumbnailSessions();
  localStorage.clear();
  vi.restoreAllMocks();
});

const TEAM = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });

function row(index: number, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: TEAM.id,
    name: `file-${index}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 100,
    kind: 'image',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false,
    ...overrides
  };
}

function makeClient(rows: TeamMaterialRow[]): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows,
      total: rows.length,
      next: null
    })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('no session in this test')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

function renderShell(client: ExplorerShellClient, onPreview = vi.fn()) {
  const onQueryChange = vi.fn();
  render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[TEAM]}>
        <ExplorerShell
          teamId={TEAM.id}
          client={client}
          query={{ ...emptyTeamRouteQuery(), view: 'list' }}
          onQueryChange={onQueryChange}
          onFolderChange={vi.fn()}
          onSearched={vi.fn()}
          onPreview={onPreview}
        />
      </TeamProvider>
    </ToastProvider>
  );
  return { onQueryChange, onPreview };
}

describe('explorer keyboard', () => {
  it('moves, opens, toggles and clears from the keyboard', async () => {
    const { onPreview } = renderShell(makeClient([row(1), row(2), row(3)]));
    await screen.findByText('file-3.png');
    const area = document.querySelector<HTMLElement>('.team-explorer-content-keys')!;
    const selectedName = () =>
      document.querySelector('.team-explorer-row.is-selected')?.textContent ?? '';
    fireEvent.keyDown(area, { key: 'ArrowDown' });
    await waitFor(() => expect(selectedName()).toContain('file-1.png'));
    fireEvent.keyDown(area, { key: 'ArrowDown' });
    await waitFor(() => expect(selectedName()).toContain('file-2.png'));
    fireEvent.keyDown(area, { key: ' ' });
    // The bar's own name is static; the count is the text inside it.
    const bar = await screen.findByRole('region', { name: 'What to do with the selection' });
    expect(bar.textContent).toContain('Selected: 1');
    fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() =>
      expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-2' }))
    );
    fireEvent.keyDown(area, { key: 'Escape' });
    await waitFor(() =>
      expect(document.querySelector('.team-explorer-row.is-selected')).toBeNull()
    );
    expect(screen.queryByRole('region', { name: 'What to do with the selection' })).toBeNull();
  });

  it('follows the selected row in the pane', async () => {
    renderShell(makeClient([row(1)]));
    await screen.findByText('file-1.png');
    expect(screen.getByText('Select a file to see it here.')).toBeTruthy();
    fireEvent.click(document.querySelector('.team-explorer-row')!);
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Selected item' }).textContent).toContain(
        'file-1.png'
      )
    );
  });
});

describe('explorer narrow layout', () => {
  it('keeps the tree behind a toggle instead of dropping it', async () => {
    const user = userEvent.setup();
    renderShell(makeClient([row(1)]));
    await screen.findByText('file-1.png');
    const shell = document.querySelector('.team-explorer')!;
    expect(shell.classList.contains('is-tree-open')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Folders' }));
    expect(shell.classList.contains('is-tree-open')).toBe(true);
    // The tree is still in the document either way; CSS decides its visibility per width.
    expect(screen.getByRole('complementary', { name: 'Folders' })).toBeTruthy();
  });
});

/**
 * Found in the browser (011 findings H): keys typed into the rename field
 * reached the explorer's shortcuts, Delete did nothing, and `/` only worked
 * once the search it was meant to open was already on screen.
 */
describe('explorer keyboard, second pass', () => {
  function actionsClient() {
    return {
      trashMaterial: vi.fn().mockResolvedValue({ state: 'succeeded' }),
      restoreMaterial: vi.fn().mockResolvedValue({ state: 'succeeded' }),
      renameMaterial: vi.fn().mockResolvedValue({ state: 'succeeded' })
    };
  }

  function renderWithActions(rows: TeamMaterialRow[]) {
    // The shell reads its permissions from the active space.
    localStorage.setItem('wishly.active-team.v1', TEAM.id);
    const actions = actionsClient();
    const onQueryChange = vi.fn();
    const onPreview = vi.fn();
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[TEAM]}>
          <ExplorerShell
            teamId={TEAM.id}
            client={makeClient(rows)}
            actionsClient={actions as never}
            query={{ ...emptyTeamRouteQuery(), view: 'list' }}
            onQueryChange={onQueryChange}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={onPreview}
          />
        </TeamProvider>
      </ToastProvider>
    );
    return { actions, onQueryChange, onPreview };
  }

  it('sends the focused row to the trash on Delete and offers the way back', async () => {
    const user = userEvent.setup();
    const { actions } = renderWithActions([row(1), row(2)]);
    await screen.findByText('file-2.png');
    const area = document.querySelector<HTMLElement>('.team-explorer-content-keys')!;
    fireEvent.keyDown(area, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(document.querySelector('.team-explorer-row.is-selected')?.textContent).toContain(
        'file-1.png'
      )
    );
    fireEvent.keyDown(area, { key: 'Delete' });
    await waitFor(() =>
      expect(actions.trashMaterial).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEAM.id, materialId: 'id-1' })
      )
    );
    await screen.findByText('Moved to trash');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(actions.restoreMaterial).toHaveBeenCalledWith(
        expect.objectContaining({ materialId: 'id-1' })
      )
    );
    await screen.findByText('Restored');
  });

  it('leaves the rename field its own keys, focused with the base name selected', async () => {
    const user = userEvent.setup();
    const { actions, onPreview } = renderWithActions([row(1)]);
    await screen.findByText('file-1.png');
    await user.click(screen.getByRole('button', { name: 'Actions for file-1.png' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('New name') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'file-1'.length]);
    // The menu's items stepped aside for the form.
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    await user.keyboard('walk one{Enter}');
    await waitFor(() =>
      expect(actions.renameMaterial).toHaveBeenCalledWith(
        expect.objectContaining({ materialId: 'id-1', newName: 'walk one.png' })
      )
    );
    expect(onPreview).not.toHaveBeenCalled();
    // Space in the new name toggled nothing.
    expect(screen.queryByRole('region', { name: 'What to do with the selection' })).toBeNull();
  });

  it('opens the search on `/` before the search bar exists', async () => {
    const { onQueryChange } = renderWithActions([row(1)]);
    await screen.findByText('file-1.png');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(onQueryChange).toHaveBeenCalledWith({ scope: 'space' });
  });
});

/**
 * The batch's way in, under the keyboard.
 *
 * "Process" was reachable only through an unlabelled ▶ that appeared after
 * something was selected — and that button then ignored the selection. It is a
 * toolbar door now, and a door that says `role="menu"` has to answer arrow keys
 * and hand focus back where it came from: choosing an item unmounts it, and the
 * window that opens next restores focus to whatever was focused when it
 * appeared.
 */
describe('the batch entry points', () => {
  const FOLDER: TeamFolderNode = {
    id: 'folder-row',
    driveFileId: 'drive-folder',
    parentFolderId: null,
    selectionId: null,
    name: 'spy joints',
    indexedAt: null,
    childFolderCount: 0,
    childFileCount: 2,
    thumbnailReadyCount: 0
  };

  function renderInFolder(rows: TeamMaterialRow[]) {
    // The provider reads the active space from storage; without it the space has
    // no permissions and the toolbar renders no actions at all.
    localStorage.setItem('wishly.active-team.v1', TEAM.id);
    const client = makeClient(rows);
    (client.listFolderTree as ReturnType<typeof vi.fn>).mockResolvedValue([FOLDER]);
    const onProcessSelection = vi.fn();
    const onProcessLibrary = vi.fn();
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[TEAM]}>
          <ExplorerShell
            teamId={TEAM.id}
            client={client}
            query={{ ...emptyTeamRouteQuery(), view: 'list', folderId: FOLDER.driveFileId }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={vi.fn()}
            onProcessSelection={onProcessSelection}
            onProcessLibrary={onProcessLibrary}
          />
        </TeamProvider>
      </ToastProvider>
    );
    return { onProcessSelection, onProcessLibrary };
  }

  it('opens the scope menu from the keyboard and gives focus back on Escape', async () => {
    const user = userEvent.setup();
    const { onProcessLibrary } = renderInFolder([row(1), row(2)]);
    const button = await screen.findByRole('button', { name: 'Process' });

    button.focus();
    await user.keyboard('{Enter}');
    const items = await screen.findAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual([
      'This folder and everything in it',
      'Compress everything in this folder',
      'Refresh landing previews',
      'Everything in the space'
    ]);
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items[3]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
    expect(document.activeElement).toBe(button);

    await user.click(button);
    await user.click(await screen.findByRole('menuitem', { name: 'Everything in the space' }));
    expect(onProcessLibrary).toHaveBeenCalledTimes(1);
    // The trigger takes focus back before the window opens, so the window has
    // something live to restore to when it closes.
    expect(document.activeElement).toBe(button);
  });

  it('hands the batch every chosen file it can take, and counts only those', async () => {
    const user = userEvent.setup();
    const clip = (index: number) =>
      row(index, {
        name: `clip-${index}.mp4`,
        category: 'video',
        kind: 'video',
        mimeType: 'video/mp4',
        fileExtension: 'mp4'
      });
    // The third is an image: checkable like anything else, and nothing the
    // batch can do. It must not be counted and must not be sent.
    const { onProcessSelection } = renderInFolder([clip(1), clip(2), row(3)]);
    await screen.findByText('file-3.png');
    const boxes = document.querySelectorAll<HTMLInputElement>(
      '.team-explorer-row input[type="checkbox"]'
    );
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    await user.click(boxes[2]!);

    const process = await screen.findByRole('button', { name: 'Process 2' });
    await user.click(process);
    expect(onProcessSelection).toHaveBeenCalledWith(['id-1', 'id-2'], {
      kind: 'selection',
      count: 2,
      picked: 3
    });
  });

  it('offers no batch at all when nothing chosen can be processed', async () => {
    const user = userEvent.setup();
    renderInFolder([row(1), row(2)]);
    await screen.findByText('file-2.png');
    const boxes = document.querySelectorAll<HTMLInputElement>(
      '.team-explorer-row input[type="checkbox"]'
    );
    await user.click(boxes[0]!);
    const bar = await screen.findByRole('region', { name: 'What to do with the selection' });
    // "Everything is already up to date" over an image reads as done; the
    // honest answer is not to offer the action. (The toolbar's own scope menu
    // is a different button and stays.)
    expect(
      Array.from(bar.querySelectorAll('button')).map(button => button.getAttribute('aria-label'))
    ).not.toContain('Process');
  });

  it('reaches rows past the first page from the keyboard and the pane', async () => {
    const user = userEvent.setup();
    // Two pages: the explorer used to list the folder twice, and only the grid's
    // own copy ever paged — so everything the shell decided (the pane, the
    // arrows, Delete, the upload's name check) stopped at row 100 forever.
    const all = Array.from({ length: 120 }, (_, index) => row(index));
    const client = makeClient(all);
    (client.listFolderPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_teamId: string, input: { after: { id: string } | null }) => {
        const start = input.after ? all.findIndex(item => item.id === input.after!.id) + 1 : 0;
        const rows = all.slice(start, start + 100);
        const last = rows[rows.length - 1];
        return {
          rows,
          total: all.length,
          next: start + rows.length < all.length ? { sortKey: last!.name, id: last!.id } : null
        };
      }
    );
    localStorage.setItem('wishly.active-team.v1', TEAM.id);
    renderShell(client);
    await screen.findByText('file-0.png');
    // One listing for the folder, not two.
    expect(client.listFolderPage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    const later = await screen.findByText('file-110.png');
    await user.click(later);
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Selected item' }).textContent).toContain(
        'file-110.png'
      )
    );
  });

  it('says how much of the selection is no longer on screen', async () => {
    const user = userEvent.setup();
    // The selection survives walking into another folder, which is what makes
    // it useful and what makes the bin a surprise.
    const inside = row(9, { name: 'inside.png', parentFolderId: 'nested' });
    const folderRow = row(2, {
      name: 'nested',
      kind: 'folder',
      category: null,
      driveFileId: 'nested',
      parentFolderId: FOLDER.driveFileId
    } as Partial<TeamMaterialRow>);
    const client = makeClient([]);
    (client.listFolderPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_teamId: string, input: { parentFolderId: string | null }) => {
        const rows = input.parentFolderId === 'nested' ? [inside] : [row(1), folderRow];
        return { rows, total: rows.length, next: null };
      }
    );
    localStorage.setItem('wishly.active-team.v1', TEAM.id);
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[TEAM]}>
          <ExplorerShell
            teamId={TEAM.id}
            client={client}
            query={{ ...emptyTeamRouteQuery(), view: 'list', folderId: FOLDER.driveFileId }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={vi.fn()}
          />
        </TeamProvider>
      </ToastProvider>
    );
    await screen.findByText('file-1.png');
    await user.click(document.querySelector('.team-explorer-row input[type="checkbox"]')!);
    let bar = await screen.findByRole('region', { name: 'What to do with the selection' });
    // On screen, so nothing is elsewhere — including at the root, where the
    // folder id is null and every row still carries the drive's real one.
    expect(bar.textContent).toContain('Selected: 1');
    expect(bar.textContent).not.toContain('from other folders');

    // Two presses to open, one to select: the list's own grammar (011).
    await user.dblClick(screen.getByText('nested'));
    await screen.findByText('inside.png');
    bar = await screen.findByRole('region', { name: 'What to do with the selection' });
    expect(bar.textContent).toContain('1 from other folders');
  });
});
