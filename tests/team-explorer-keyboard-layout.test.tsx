// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
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
    await screen.findByRole('region', { name: 'Selected: 1' });
    fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() =>
      expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-2' }))
    );
    fireEvent.keyDown(area, { key: 'Escape' });
    await waitFor(() =>
      expect(document.querySelector('.team-explorer-row.is-selected')).toBeNull()
    );
    expect(screen.queryByRole('region', { name: /Selected/ })).toBeNull();
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
    expect(screen.queryByRole('region', { name: /Selected/ })).toBeNull();
  });

  it('opens the search on `/` before the search bar exists', async () => {
    const { onQueryChange } = renderWithActions([row(1)]);
    await screen.findByText('file-1.png');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(onQueryChange).toHaveBeenCalledWith({ scope: 'space' });
  });
});
