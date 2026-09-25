// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceOperationsProvider,
  type WorkspaceOperationsClient,
  type WorkspaceOperationGroup
} from '../apps/web/src/team/explorer/WorkspaceOperationsProvider';
import { useWorkspaceOperations } from '../apps/web/src/team/explorer/useWorkspaceOperations';
import { buildLocalManifest } from '../apps/web/src/team/explorer/localManifest';
import { handleDirectory, handleFile, localFile } from './fixtures/local-manifest';

const destination = { driveFolderId: 'drive-root', materialId: 'material-root' };
const teamId = 'team-operations';
afterEach(() => cleanup());

function mount(client: WorkspaceOperationsClient) {
  return renderHook(() => useWorkspaceOperations(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceOperationsProvider teamId={teamId} client={client}>
        {children}
      </WorkspaceOperationsProvider>
    )
  });
}

describe('workspace upload coordinator', () => {
  it('creates parent folders once, preserves empty folders and confirms catalog before success', async () => {
    const ensureFolder = vi.fn(
      async (_team: string, input: { name: string; parentMaterialId: string | null }) => ({
        folderId: `created-drive-${input.name}`,
        materialId: `created-material-${input.name}`
      })
    );
    const uploadFile = vi.fn(async () => ({}));
    const client = { ensureFolder, uploadFile };
    const manifest = await buildLocalManifest([
      {
        kind: 'directory_handle',
        handle: handleDirectory('root', [
          handleDirectory('empty'),
          handleDirectory('nested', [handleFile(localFile('a.txt'))])
        ])
      }
    ]);
    const confirmCatalog = vi.fn(async () => undefined);
    const view = mount(client);
    let group: WorkspaceOperationGroup | undefined;
    await act(async () => {
      group = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog
      });
    });
    expect(
      ensureFolder.mock.calls.map(([, input]) => [input.name, input.parentMaterialId])
    ).toEqual([
      ['root', 'material-root'],
      ['empty', 'created-material-root'],
      ['nested', 'created-material-root']
    ]);
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationFolderId: 'created-drive-nested',
        file: expect.objectContaining({ name: 'a.txt' })
      })
    );
    expect(confirmCatalog).toHaveBeenCalledTimes(1);
    expect(group).toMatchObject({ state: 'succeeded', stage: 'done' });
    expect(view.result.current.groups[0]).toMatchObject({ state: 'succeeded' });
  });

  it('skips a failed parent subtree but completes independent files as partial', async () => {
    const ensureFolder = vi.fn(async (_team: string, input: { name: string }) => {
      if (input.name === 'bad')
        throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
      return { folderId: `drive-${input.name}`, materialId: `material-${input.name}` };
    });
    const uploadFile = vi.fn(async () => ({}));
    const manifest = await buildLocalManifest([
      {
        kind: 'directory_handle',
        handle: handleDirectory('root', [
          handleDirectory('bad', [handleFile(localFile('blocked.txt'))]),
          handleFile(localFile('good.txt'))
        ])
      }
    ]);
    const view = mount({ ensureFolder, uploadFile });
    let group: WorkspaceOperationGroup | undefined;
    await act(async () => {
      group = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog: async () => undefined
      });
    });
    expect(group).toMatchObject({ state: 'partial' });
    expect(group?.items.find(item => item.relativePath.endsWith('blocked.txt'))).toMatchObject({
      state: 'skipped',
      errorCode: 'PARENT_FAILED'
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ name: 'good.txt' })
      })
    );
  });

  it('bounds active transfers to three per group and six across the provider', async () => {
    let active = 0;
    let maximum = 0;
    const client: WorkspaceOperationsClient = {
      ensureFolder: vi.fn(),
      uploadFile: vi.fn(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        return {};
      })
    };
    const manifest = await buildLocalManifest(
      Array.from({ length: 9 }, (_, index) => ({
        kind: 'file' as const,
        file: localFile(`f-${index}.txt`)
      }))
    );
    const view = mount(client);
    let groups: WorkspaceOperationGroup[] | undefined;
    await act(async () => {
      groups = await Promise.all(
        Array.from({ length: 3 }, () =>
          view.result.current.startUploadGroup({
            teamId,
            destination,
            manifest,
            confirmCatalog: async () => undefined
          })
        )
      );
    });
    expect(maximum).toBe(6);
    expect(groups).toHaveLength(3);
    await waitFor(() => expect(view.result.current.groups).toHaveLength(3));
  });

  it('does not report success when the authoritative catalog read fails', async () => {
    const manifest = await buildLocalManifest([{ kind: 'file', file: localFile('a.txt') }]);
    const view = mount({ ensureFolder: vi.fn(), uploadFile: vi.fn(async () => ({})) });
    let group: WorkspaceOperationGroup | undefined;
    await act(async () => {
      group = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog: async () => {
          throw new Error('CATALOG_READ_FAILED');
        }
      });
    });
    expect(group).toMatchObject({ state: 'partial', stage: 'done' });
  });

  it('does not write remotely when enumeration exceeds its bound', async () => {
    const files = Array.from({ length: 1001 }, (_, index) => ({
      kind: 'file' as const,
      file: localFile(`f-${index}.txt`)
    }));
    const manifest = await buildLocalManifest(files);
    const client = { ensureFolder: vi.fn(), uploadFile: vi.fn() };
    const view = mount(client);
    let group: WorkspaceOperationGroup | undefined;
    await act(async () => {
      group = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog: vi.fn()
      });
    });
    expect(group?.state).toBe('failed');
    expect(client.ensureFolder).not.toHaveBeenCalled();
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a known name conflict without a person choosing the outcome', async () => {
    const manifest = await buildLocalManifest([{ kind: 'file', file: localFile('same.txt') }]);
    const uploadFile = vi.fn();
    const view = mount({ ensureFolder: vi.fn(), uploadFile });
    let group: WorkspaceOperationGroup | undefined;
    await act(async () => {
      group = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        existingByName: new Map([['same.txt', 'existing-id']]),
        confirmCatalog: async () => undefined
      });
    });
    expect(group?.items[0]).toMatchObject({
      state: 'failed',
      errorCode: 'CONFLICT_NEEDS_DECISION'
    });
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
