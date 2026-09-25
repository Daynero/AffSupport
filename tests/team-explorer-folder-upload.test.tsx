// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamFolderNode, TeamMaterialRow } from '@video-compressor/shared';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { teamApi } from '../apps/web/src/api/team';
import { uploadTeamFile } from '../apps/web/src/team/catalog/material-actions-client';
import { makeTeam } from './team-space-fixtures';

vi.mock('../apps/web/src/team/catalog/material-actions-client', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../apps/web/src/team/catalog/material-actions-client')>();
  return { ...actual, uploadTeamFile: vi.fn().mockResolvedValue({}) };
});
vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      ensureUploadFolder: vi.fn().mockResolvedValue({
        folderId: 'created-drive-folder',
        materialId: 'created-folder',
        name: 'created',
        created: true
      })
    }
  };
});

const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });
const folders: TeamFolderNode[] = ['drive-a', 'drive-b'].map(id => ({
  id,
  driveFileId: id,
  parentFolderId: null,
  selectionId: null,
  name: id,
  indexedAt: '2026-09-25T00:00:00Z',
  childFolderCount: 0,
  childFileCount: 0,
  thumbnailReadyCount: 0
}));

function client(rows: TeamMaterialRow[] = []): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue(folders),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows,
      total: rows.length,
      next: null
    })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('unused')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

function shell(folderId: string | null) {
  return (
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        <ExplorerShell
          teamId={team.id}
          client={testClient}
          query={{ ...emptyTeamRouteQuery(), folderId, view: 'list' }}
          onQueryChange={vi.fn()}
          onFolderChange={vi.fn()}
          onSearched={vi.fn()}
          onPreview={vi.fn()}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

let testClient: ExplorerShellClient;
beforeEach(() => localStorage.setItem('wishly.active-team.v1', team.id));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('folder intake in Explorer', () => {
  it('freezes the drop destination before asynchronous file enumeration', async () => {
    testClient = client();
    let deliver!: (file: File) => void;
    const file = new File(['content'], 'image.png', { type: 'image/png' });
    const entry = {
      name: file.name,
      isFile: true,
      isDirectory: false,
      file: (success: (value: File) => void) => {
        deliver = success;
      }
    };
    const view = render(shell('drive-a'));
    await waitFor(() => expect(document.querySelector('.team-explorer-dropzone')).toBeTruthy());
    const zone = document.querySelector('.team-explorer-dropzone')!;
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => entry }], files: [] }
    });
    expect(deliver).toBeTypeOf('function');
    view.rerender(shell('drive-b'));
    deliver(file);
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalled());
    expect(uploadTeamFile).toHaveBeenCalledWith(
      expect.objectContaining({ destinationFolderId: 'drive-a', file })
    );
  });

  it('continues other files when one parent folder cannot be created', async () => {
    testClient = client();
    vi.mocked(teamApi.ensureUploadFolder).mockImplementation(async (_teamId, request) => {
      if (request.name === 'bad') throw new Error('PERMISSION_DENIED');
      return {
        folderId: 'good-folder',
        materialId: 'good-folder',
        name: request.name,
        created: true
      };
    });
    render(shell(null));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const bad = new File(['a'], 'a.txt');
    const good = new File(['b'], 'b.txt');
    Object.defineProperty(bad, 'webkitRelativePath', { value: 'bad/a.txt' });
    Object.defineProperty(good, 'webkitRelativePath', { value: 'good/b.txt' });
    fireEvent.change(input, { target: { files: [bad, good] } });
    await waitFor(() =>
      expect(uploadTeamFile).toHaveBeenCalledWith(
        expect.objectContaining({ file: good, destinationFolderId: 'good-folder' })
      )
    );
    expect(uploadTeamFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadTeamFile).mock.calls[0]?.[0].file).toBe(good);
  });

  it('requires an explicit conflict choice before uploading a same-name file', async () => {
    const existing: TeamMaterialRow = {
      id: 'existing',
      teamId: team.id,
      name: 'same.txt',
      category: 'other',
      mimeType: 'text/plain',
      fileExtension: 'txt',
      sizeBytes: 1,
      kind: 'document',
      driveFileId: 'drive-existing',
      parentFolderId: null,
      modifiedAt: null,
      driveVersion: '1',
      previewState: 'pending',
      thumbnailReady: false
    };
    testClient = client([existing]);
    render(shell(null));
    await screen.findByText('same.txt');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['new'], 'same.txt')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this one' }));
    expect(uploadTeamFile).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [new File(['newer'], 'same.txt')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep both' }));
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(1));
  });
});
