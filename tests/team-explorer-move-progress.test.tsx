// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type FolderPage,
  type TeamFolderNode,
  type TeamMaterialRow
} from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { useExplorerClipboard } from '../apps/web/src/team/explorer/useExplorerClipboard';
import {
  useMaterialActions,
  type MaterialActionsClient
} from '../apps/web/src/team/catalog/useMaterialActions';
import type { TailClient } from '../apps/web/src/team/materials/tail';
import { ExplorerShell } from '../apps/web/src/team/explorer/ExplorerShell';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { makeTeam } from './team-space-fixtures';
import { moveWorkspaceMaterials } from '../apps/web/src/team/explorer/moveCoordinator';

const teamId = 'team-one';
const material = (id: string, sourceFolderId: string | null = 'old-folder') => ({
  id,
  name: `${id}.txt`,
  category: null,
  sourceFolderId
});
const wrap = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
afterEach(cleanup);

describe('workspace move coordinator', () => {
  it('counts completed server outcomes and invalidates both parent folders', async () => {
    const moveMaterial = vi.fn(async () => ({
      operationId: crypto.randomUUID(),
      state: 'succeeded' as const,
      materialId: 'moved',
      reused: false
    }));
    const progress = vi.fn();
    const invalidated = vi.fn();
    const outcome = await moveWorkspaceMaterials({
      teamId,
      items: [material('a'), material('b')],
      destinationFolderId: 'new-folder',
      conflictMode: 'keep_both',
      client: { moveMaterial },
      onProgress: progress,
      onInvalidated: invalidated
    });
    expect(progress.mock.calls.map(([value]) => value.progress)).toEqual([0, 50, 100]);
    expect(outcome).toMatchObject({ completed: 2, failed: 0, error: null });
    expect(outcome.affectedFolderIds).toEqual(['old-folder', 'new-folder']);
    expect(invalidated).toHaveBeenCalledWith(['old-folder', 'new-folder']);
    expect(moveMaterial).toHaveBeenCalledTimes(2);
  });

  it('leaves a single menu move indeterminate until the server confirms it', async () => {
    const states: Array<number | 'indeterminate'> = [];
    const outcome = await moveWorkspaceMaterials({
      teamId,
      items: [material('one')],
      destinationFolderId: null,
      conflictMode: 'cancel',
      client: {
        moveMaterial: vi.fn(async () => ({
          operationId: 'operation',
          state: 'succeeded' as const,
          materialId: 'one',
          reused: false
        }))
      },
      onProgress: value => states.push(value.progress)
    });
    expect(states).toEqual(['indeterminate', 100]);
    expect(outcome.affectedFolderIds).toEqual(['old-folder', null]);
  });

  it.each(['CYCLE', 'PERMISSION_DENIED'])(
    'stops a batch on server %s rejection without claiming success or invalidating',
    async code => {
      const moveMaterial = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
      const invalidated = vi.fn();
      const outcome = await moveWorkspaceMaterials({
        teamId,
        items: [material('a'), material('b')],
        destinationFolderId: 'new-folder',
        conflictMode: 'keep_both',
        client: { moveMaterial },
        onInvalidated: invalidated
      });
      expect(outcome).toMatchObject({ completed: 0, failed: 1, progress: 0 });
      expect(outcome.error).toMatchObject({ code });
      expect(outcome.affectedFolderIds).toEqual([]);
      expect(moveMaterial).toHaveBeenCalledTimes(1);
      expect(invalidated).not.toHaveBeenCalled();
    }
  );

  it('routes clipboard cut through the same move path and preserves the destination', async () => {
    const moveMaterial = vi.fn(async () => ({
      operationId: 'operation',
      state: 'succeeded' as const,
      materialId: 'a',
      reused: false
    }));
    const onChanged = vi.fn();
    const clipboard = renderHook(
      () =>
        useExplorerClipboard({
          teamId,
          currentFolderId: 'new-folder',
          permissions: DEFAULT_ROLE_PERMISSIONS.admin,
          tailClient: { moveMaterial } as unknown as TailClient,
          onChanged,
          clearSelection: vi.fn()
        }),
      { wrapper: wrap }
    );
    act(() =>
      clipboard.result.current.take('cut', [
        { id: 'a', name: 'a.txt', kind: 'file', category: null, sourceFolderId: 'old-folder' }
      ])
    );
    await act(async () => clipboard.result.current.paste());
    expect(moveMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        materialId: 'a',
        destinationFolderId: 'new-folder',
        conflictMode: 'keep_both'
      })
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('routes a menu move through the same path and reports permission rejection', async () => {
    const moveMaterial = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' })
      );
    const onChanged = vi.fn();
    const actions = renderHook(
      () =>
        useMaterialActions({
          teamId,
          material: {
            id: 'a',
            teamId,
            name: 'a.txt',
            kind: 'file',
            category: null,
            parentFolderId: 'old-folder'
          },
          client: { moveMaterial } as unknown as MaterialActionsClient,
          onChanged
        }),
      { wrapper: wrap }
    );
    let code: string | null = null;
    await act(async () => {
      code = await actions.result.current.move('new-folder');
    });
    expect(code).toBe('PERMISSION_DENIED');
    expect(moveMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        materialId: 'a',
        destinationFolderId: 'new-folder',
        conflictMode: 'cancel'
      })
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('routes a list drop onto a folder through the coordinator', async () => {
    const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });
    localStorage.setItem('wishly.active-team.v1', team.id);
    const base = {
      teamId: team.id,
      category: null,
      mimeType: null,
      fileExtension: null,
      sizeBytes: null,
      parentFolderId: null,
      modifiedAt: null,
      driveVersion: '1',
      previewState: 'pending' as const,
      thumbnailReady: false
    };
    const rows: TeamMaterialRow[] = [
      { ...base, id: 'folder', name: 'Target', kind: 'folder', driveFileId: 'drive-target' },
      { ...base, id: 'file', name: 'source.txt', kind: 'file', driveFileId: 'drive-file' }
    ];
    const folders: TeamFolderNode[] = [
      {
        id: 'folder',
        driveFileId: 'drive-target',
        parentFolderId: null,
        selectionId: null,
        name: 'Target',
        indexedAt: '2026-09-25T00:00:00Z',
        childFolderCount: 0,
        childFileCount: 0,
        thumbnailReadyCount: 0
      }
    ];
    const moveMaterial = vi.fn(async () => ({
      operationId: 'move-op',
      state: 'succeeded' as const,
      materialId: 'file',
      reused: false
    }));
    const client = {
      listFolderTree: vi.fn().mockResolvedValue(folders),
      listFolderPage: vi.fn(async (): Promise<FolderPage> => ({ rows, total: 2, next: null })),
      mintThumbnailSession: vi.fn().mockRejectedValue(new Error('unused')),
      thumbnailUrl: () => '',
      listMaterials: vi.fn().mockResolvedValue([]),
      searchCatalog: vi.fn(),
      getCatalogVocabulary: vi.fn().mockResolvedValue({
        geo: [],
        languages: [],
        offers: [],
        tags: []
      }),
      updateMaterialMetadata: vi.fn()
    };
    const transfer = new Map<string, string>();
    const dataTransfer = {
      setData: (kind: string, value: string) => transfer.set(kind, value),
      getData: (kind: string) => transfer.get(kind) ?? '',
      get types() {
        return [...transfer.keys()];
      },
      setDragImage: vi.fn(),
      effectAllowed: 'all',
      dropEffect: 'none'
    };
    render(
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[team]}>
          <ExplorerShell
            teamId={team.id}
            client={client}
            actionsClient={{ moveMaterial } as unknown as MaterialActionsClient}
            query={{ ...emptyTeamRouteQuery(), view: 'list' }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
          />
        </TeamProvider>
      </ToastProvider>
    );
    const file = (await screen.findByText('source.txt')).closest('[role="row"]')!;
    const folder = screen.getAllByText('Target')
      .map(element => element.closest('[role="row"]'))
      .find((row): row is HTMLElement => row instanceof HTMLElement)!;
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    await waitFor(() =>
      expect(moveMaterial).toHaveBeenCalledWith(
        expect.objectContaining({
          materialId: 'file',
          destinationFolderId: 'drive-target',
          conflictMode: 'keep_both'
        })
      )
    );
  });
});
