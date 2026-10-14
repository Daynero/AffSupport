// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { executeBulkTrash } from '../apps/web/src/team/explorer/bulkTrash';
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
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client';
import { makeTeam } from './team-space-fixtures';
import { WorkspaceOperationsProvider } from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';

const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });

describe('50-file bulk trash dispatch', () => {
  it('bounds concurrency, preserves per-item retry keys and continues after a failure', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      materialId: `material-${index}`,
      idempotencyKey: `stable-key-${index}`
    }));
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const settled = vi.fn();
    const outcome = await executeBulkTrash({
      intent: { id: 'group', requestId: 'request', items },
      mark: async materialId => {
        calls.push(`mark:${materialId}`);
      },
      trash: async (materialId, key) => {
        calls.push(`${materialId}:${key}`);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        if (materialId === 'material-17') throw new Error('timeout');
      },
      settled
    });
    expect(outcome).toEqual({ attempted: 50, transportErrors: 1 });
    expect(peak).toBe(6);
    expect(calls.filter(value => value.startsWith('material-'))).toHaveLength(50);
    expect(calls).toContain('material-49:stable-key-49');
    expect(settled).toHaveBeenCalledTimes(50);
  });
});

it('keeps the 50-item selection responsive and reports a partial hosted result', async () => {
  const rows: TeamMaterialRow[] = Array.from({ length: 50 }, (_, index) => ({
    id: `material-${index}`,
    teamId: team.id,
    name: `clip-${index}.txt`,
    category: 'other',
    mimeType: 'text/plain',
    fileExtension: 'txt',
    sizeBytes: 1,
    kind: 'other',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false
  }));
  const receiptItems = rows.map((row, index) => ({
    materialId: row.id,
    idempotencyKey: `key-${index}`,
    operationId: null,
    state: 'queued' as 'queued' | 'confirmed' | 'failed',
    errorCode: null
  }));
  const client = {
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({ rows, total: 50, next: null })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('no thumbnail')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn(),
    beginBulkTrash: vi.fn(async () => ({
      id: 'group',
      requestId: 'request',
      items: receiptItems.map(({ materialId, idempotencyKey }) => ({ materialId, idempotencyKey }))
    })),
    markBulkTrashAttempt: vi.fn(async () => undefined),
    prepareBulkTrashRetry: vi.fn(async ({ materialId }: { materialId: string }) => {
      const item = receiptItems.find(entry => entry.materialId === materialId)!;
      item.idempotencyKey = 'retry-key-17';
      item.state = 'queued';
      return { status: 'retryable' as const, idempotencyKey: item.idempotencyKey };
    }),
    listBulkTrash: vi.fn(async () => [
      {
        id: 'group',
        requestId: 'request',
        createdAt: '2026-10-09T10:00:00Z',
        items: receiptItems
      }
    ])
  } as unknown as ExplorerShellClient;
  let failOnce = true;
  const trashMaterial = vi.fn(async ({ materialId }: { materialId: string }) => {
    const item = receiptItems.find(entry => entry.materialId === materialId)!;
    item.state = materialId === 'material-17' && failOnce ? 'failed' : 'confirmed';
    if (item.state === 'failed') failOnce = false;
    if (item.state === 'failed') throw new Error('PROVIDER_FAILURE');
    return { operationId: materialId, state: 'succeeded' };
  });
  localStorage.setItem('wishly.active-team.v1', team.id);
  render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[team]}>
        <WorkspaceOperationsProvider
          teamId={team.id}
          client={{
            ensureFolder: vi.fn(),
            uploadFile: vi.fn(),
            listBulkTrash: client.listBulkTrash!
          }}
        >
          <ExplorerShell
            teamId={team.id}
            client={client}
            query={{ ...emptyTeamRouteQuery(), view: 'list' }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={vi.fn()}
            actionsClient={{ trashMaterial } as unknown as MaterialActionsClient}
          />
        </WorkspaceOperationsProvider>
      </TeamProvider>
    </ToastProvider>
  );
  await screen.findAllByText('clip-49.txt');
  const boxes = document.querySelectorAll<HTMLElement>('.team-explorer-row-check input');
  expect(boxes).toHaveLength(50);
  for (const box of boxes) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
  await waitFor(() => expect(trashMaterial).toHaveBeenCalledTimes(50), { timeout: 15_000 });
  expect(vi.mocked(client.beginBulkTrash)).toHaveBeenCalledTimes(1);
  expect(trashMaterial).toHaveBeenCalledWith(
    expect.objectContaining({
      materialId: 'material-49',
      idempotencyKey: 'key-49'
    })
  );
  await screen.findByText(/Moved 49 of 50 files to trash/);
  const receipts = screen.getByRole('list', { name: 'Moving files to trash' });
  expect(within(receipts).getAllByText('In trash')).toHaveLength(49);
  expect(within(receipts).getByText('Failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry unresolved files' }));
  await waitFor(() => expect(trashMaterial).toHaveBeenCalledTimes(51));
  expect(client.prepareBulkTrashRetry).toHaveBeenCalledTimes(1);
  expect(trashMaterial).toHaveBeenLastCalledWith(
    expect.objectContaining({
      materialId: 'material-17',
      idempotencyKey: 'retry-key-17'
    })
  );
  await waitFor(() => expect(within(receipts).getAllByText('In trash')).toHaveLength(50));
  cleanup();
  localStorage.clear();
}, 30_000);
