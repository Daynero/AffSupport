// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import {
  WorkspaceOperationsProvider,
  WorkspaceOperationsContextOverride,
  type WorkspaceOperationsValue
} from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';

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

function shell(folderId: string | null, coordinated = false) {
  const explorer = (
    <ExplorerShell
      teamId={team.id}
      client={testClient}
      query={{ ...emptyTeamRouteQuery(), folderId, view: 'list' }}
      onQueryChange={vi.fn()}
      onFolderChange={vi.fn()}
      onSearched={vi.fn()}
      onPreview={vi.fn()}
    />
  );
  return (
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        {coordinated ? (
          <WorkspaceOperationsProvider teamId={team.id}>{explorer}</WorkspaceOperationsProvider>
        ) : (
          explorer
        )}
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
  it('reselects into the original destination through retry, never a fresh group', async () => {
    testClient = client();
    const retryUploadGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error('RESELECTION_MISMATCH'))
      .mockResolvedValue({ state: 'succeeded' });
    const startUploadGroup = vi.fn();
    const onRetryComplete = vi.fn();
    const value: WorkspaceOperationsValue = {
      groups: [
        {
          id: 'retry-me',
          teamId: team.id,
          destination: { driveFolderId: 'drive-a', materialId: 'folder-a' },
          state: 'partial',
          stage: 'done',
          items: [
            {
              clientItemKey: 'file:retry.txt:1',
              relativePath: 'retry.txt',
              idempotencyKey: 'key',
              state: 'failed',
              errorCode: 'DRIVE_UNAVAILABLE'
            }
          ]
        }
      ],
      startUploadGroup,
      retryUploadGroup,
      cancelGroup: vi.fn()
    };
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[team]}>
          <WorkspaceOperationsContextOverride value={value}>
            <ExplorerShell
              teamId={team.id}
              client={testClient}
              retryGroupId="retry-me"
              onRetryComplete={onRetryComplete}
              query={{ ...emptyTeamRouteQuery(), folderId: 'drive-b', view: 'list' }}
              onQueryChange={vi.fn()}
              onFolderChange={vi.fn()}
              onSearched={vi.fn()}
            />
          </WorkspaceOperationsContextOverride>
        </TeamProvider>
      </ToastProvider>
    );
    expect(screen.getByText(/Select the same files again/i)).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'retry.txt')] } });
    await waitFor(() => expect(retryUploadGroup).toHaveBeenCalledOnce());
    expect(await screen.findByText(/This selection does not match the original set/i)).toBeTruthy();
    expect(onRetryComplete).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['x'], 'retry.txt')] } });
    await waitFor(() => expect(retryUploadGroup).toHaveBeenCalledTimes(2));
    expect(retryUploadGroup).toHaveBeenCalledWith(
      'retry-me',
      expect.objectContaining({
        destination: { driveFolderId: 'drive-a', materialId: 'folder-a' }
      })
    );
    expect(startUploadGroup).not.toHaveBeenCalled();
    expect(onRetryComplete).toHaveBeenCalledOnce();
  });

  it('shows discovered folder counts while a child file is still being read', async () => {
    testClient = client();
    let deliver!: (file: File) => void;
    const file = new File([], 'zero.txt');
    const child = {
      name: file.name,
      isFile: true,
      isDirectory: false,
      file: (success: (value: File) => void) => {
        deliver = success;
      }
    };
    let batch = 0;
    const root = {
      name: 'root',
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (success: (entries: unknown[]) => void) =>
          success(batch++ === 0 ? [child] : [])
      })
    };
    render(shell(null, true));
    const zone = document.querySelector('.team-explorer-dropzone')!;
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => root }], files: [] }
    });
    expect(await screen.findByText('0 files and 1 folders found')).toBeTruthy();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
    expect(deliver).toBeTypeOf('function');
    await act(async () => deliver(file));
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalled());
  });

  it('cancels delayed enumeration before any remote mutation', async () => {
    testClient = client();
    let deliver!: (file: File) => void;
    const file = new File(['x'], 'later.txt');
    const entry = {
      name: file.name,
      isFile: true,
      isDirectory: false,
      file: (success: (value: File) => void) => {
        deliver = success;
      }
    };
    render(shell(null, true));
    fireEvent.drop(document.querySelector('.team-explorer-dropzone')!, {
      dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => entry }], files: [] }
    });
    expect(await screen.findByRole('button', { name: 'Cancel operation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
    await act(async () => deliver(file));
    expect(uploadTeamFile).not.toHaveBeenCalled();
    expect(teamApi.ensureUploadFolder).not.toHaveBeenCalled();
  });

  it('preserves an empty dropped directory through the workspace coordinator', async () => {
    testClient = client();
    render(shell(null, true));
    const empty = {
      name: 'empty',
      isFile: false,
      isDirectory: true,
      createReader: () => ({ readEntries: (success: (entries: unknown[]) => void) => success([]) })
    };
    const zone = document.querySelector('.team-explorer-dropzone')!;
    fireEvent.drop(zone, {
      dataTransfer: { types: ['Files'], items: [{ webkitGetAsEntry: () => empty }], files: [] }
    });
    await waitFor(() => expect(teamApi.ensureUploadFolder).toHaveBeenCalled());
    expect(teamApi.ensureUploadFolder).toHaveBeenCalledWith(
      team.id,
      expect.objectContaining({
        name: 'empty',
        parentMaterialId: null
      })
    );
    expect(uploadTeamFile).not.toHaveBeenCalled();
  });

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
