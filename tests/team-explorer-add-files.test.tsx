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

function shell() {
  return (
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        <WorkspaceOperationsProvider teamId={team.id}>
          <ExplorerShell
            teamId={team.id}
            client={client}
            query={{ ...emptyTeamRouteQuery(), view: 'list' }}
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

describe('Add files chooser', () => {
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
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }));
    await waitFor(() =>
      expect(
        (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker
      ).toHaveBeenCalledTimes(1)
    );
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
  });

  it('does not offer a lossy webkitdirectory fallback when directory handles are unavailable', async () => {
    render(shell());
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }));
    expect(document.querySelector('input[webkitdirectory]')).toBeNull();
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
  });
});
