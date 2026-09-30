// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type FolderPage } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { WorkspaceOperationsProvider } from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';
import { buildLocalManifest } from '../apps/web/src/team/explorer/localManifest';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { teamApi } from '../apps/web/src/api/team';
import { selectNativeDirectory } from '../apps/web/src/api/client';
import { makeTeam } from './team-space-fixtures';
import {
  dropDirectory,
  dropFile,
  handleDirectory,
  handleFile,
  localFile
} from './fixtures/local-manifest';

vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      ensureUploadFolder: vi.fn().mockResolvedValue({
        folderId: 'drive-created',
        materialId: 'material-created',
        name: 'Empty',
        created: true
      })
    }
  };
});

vi.mock('../apps/web/src/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/client')>();
  return { ...actual, selectNativeDirectory: vi.fn().mockRejectedValue(new Error('UNAVAILABLE')) };
});

const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });
const client = {
  listFolderTree: vi.fn().mockResolvedValue([]),
  listFolderPage: vi.fn(async (): Promise<FolderPage> => ({ rows: [], total: 0, next: null })),
  mintThumbnailSession: vi.fn(),
  thumbnailUrl: () => '',
  listMaterials: vi.fn().mockResolvedValue([]),
  searchCatalog: vi.fn(),
  getCatalogVocabulary: vi.fn().mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
  updateMaterialMetadata: vi.fn()
} as unknown as ExplorerShellClient;

function shell(folderId: string | null = null) {
  return (
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        <WorkspaceOperationsProvider teamId={team.id}>
          <ExplorerShell
            teamId={team.id}
            client={client}
            query={{ ...emptyTeamRouteQuery(), view: 'list', folderId }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={vi.fn()}
          />
        </WorkspaceOperationsProvider>
      </TeamProvider>
    </ToastProvider>
  );
}

beforeEach(() => localStorage.setItem('wishly.active-team.v1', team.id));
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
  vi.clearAllMocks();
});

async function chooseFolder() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Add files' })).at(-1)!);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder' }));
}

describe('Add files chooser', () => {
  it('creates a folder in the open directory', async () => {
    render(shell());
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Campaign' }
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'New folder' }).at(-1)!);
    await waitFor(() =>
      expect(teamApi.ensureUploadFolder).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ name: 'Campaign', parentMaterialId: null })
      )
    );
  });

  it('uses the open folder as the new folder parent', async () => {
    vi.mocked(client.listFolderTree).mockResolvedValueOnce([
      {
        id: 'parent-material',
        driveFileId: 'parent-drive',
        parentFolderId: 'root',
        selectionId: null,
        name: 'Current',
        indexedAt: '2026-09-01T00:00:00.000Z',
        childFolderCount: 0,
        childFileCount: 0,
        thumbnailReadyCount: 0
      }
    ]);
    render(shell('parent-drive'));
    await waitFor(() => expect(client.listFolderTree).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Inside' }
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'New folder' }).at(-1)!);
    await waitFor(() =>
      expect(teamApi.ensureUploadFolder).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ name: 'Inside', parentMaterialId: 'parent-material' })
      )
    );
  });

  it('offers file and folder modes from one inventory action', async () => {
    render(shell());
    expect(screen.queryByRole('button', { name: 'Add folder' })).toBeNull();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add files' })).at(-1)!);
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('file input missing');
    const click = vi.spyOn(fileInput, 'click');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add files' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('enumerates the same mixed tree from a handle or drop entries, including an empty folder', async () => {
    const file = localFile('clip.mov', 0);
    const fromChooser = await buildLocalManifest([
      {
        kind: 'directory_handle',
        handle: handleDirectory('Campaign', [handleDirectory('Empty'), handleFile(file)])
      }
    ]);
    const fromDrop = await buildLocalManifest([
      {
        kind: 'drop_entry',
        entry: dropDirectory('Campaign', [[dropDirectory('Empty', []), dropFile(file)]])
      }
    ]);
    expect(fromChooser.entries.map(item => [item.kind, item.relativePath])).toEqual(
      fromDrop.entries.map(item => [item.kind, item.relativePath])
    );
    expect(fromChooser.totalDirectories).toBe(2);
    expect(fromChooser.totalFiles).toBe(1);
    expect(fromChooser.totalBytes).toBe(0);
  });

  it('keeps an empty-only directory selected in the browser chooser', async () => {
    (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(handleDirectory('Empty'));
    render(shell());
    await chooseFolder();
    await waitFor(() =>
      expect(teamApi.ensureUploadFolder).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ name: 'Empty', parentMaterialId: null })
      )
    );
  });

  it('does not mutate when the browser chooser is canceled', async () => {
    (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('canceled'), { name: 'AbortError' }));
    render(shell());
    await chooseFolder();
    await waitFor(() =>
      expect(
        (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker
      ).toHaveBeenCalledTimes(1)
    );
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
  });

  it('does not offer a lossy webkitdirectory fallback when directory handles are unavailable', async () => {
    render(shell());
    await chooseFolder();
    expect(document.querySelector('input[webkitdirectory]')).toBeNull();
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
    await waitFor(() => expect(selectNativeDirectory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Connect or update the agent/u)).toBeTruthy();
  });

  it('uses the native scoped fallback to create an empty-only folder', async () => {
    vi.mocked(selectNativeDirectory).mockResolvedValueOnce({
      kind: 'selected',
      grantId: '12345678-1234-1234-1234-123456789abc',
      rootName: 'Empty',
      entries: [{ kind: 'directory', relativePath: 'Empty' }]
    });
    render(shell());
    await chooseFolder();
    await waitFor(() =>
      expect(teamApi.ensureUploadFolder).toHaveBeenCalledWith(
        team.id,
        expect.objectContaining({ name: 'Empty', parentMaterialId: null })
      )
    );
    expect(document.querySelector('input[webkitdirectory]')).toBeNull();
  });

  it('treats a canceled native picker as no mutation', async () => {
    vi.mocked(selectNativeDirectory).mockResolvedValueOnce({ kind: 'canceled' });
    render(shell());
    await chooseFolder();
    await waitFor(() => expect(selectNativeDirectory).toHaveBeenCalledOnce());
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
  });
});
