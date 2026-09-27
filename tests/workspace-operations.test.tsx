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
import {
  MemoryWorkspaceJournalStorage,
  WorkspaceOperationJournal
} from '../apps/web/src/team/explorer/workspaceOperationJournal';

const destination = { driveFolderId: 'drive-root', materialId: 'material-root' };
const teamId = 'team-operations';
afterEach(() => cleanup());

function mount(client: WorkspaceOperationsClient, journal?: WorkspaceOperationJournal) {
  return renderHook(() => useWorkspaceOperations(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceOperationsProvider teamId={teamId} client={client} journal={journal}>
        {children}
      </WorkspaceOperationsProvider>
    )
  });
}

describe('workspace upload coordinator', () => {
  it('asks again when a name appears after the initial conflict snapshot', async () => {
    const uploadFile = vi
      .fn<WorkspaceOperationsClient['uploadFile']>()
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'NAME_CONFLICT' }))
      .mockResolvedValue({ state: 'succeeded', materialId: 'new-file' });
    const findConflicts = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['same.txt', 'existing']]));
    const onConflict = vi.fn(async () => 'keep_both' as const);
    const view = mount({ ensureFolder: vi.fn(), uploadFile });
    await act(async () => {
      const result = await view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest: await buildLocalManifest([{ kind: 'file', file: localFile('same.txt') }]),
        findConflicts,
        onConflict,
        confirmCatalog: async () => {}
      });
      expect(result.state).toBe('succeeded');
    });
    expect(uploadFile.mock.calls.map(([input]) => input.conflictMode)).toEqual([
      'cancel',
      'keep_both'
    ]);
    expect(onConflict).toHaveBeenCalledWith({
      name: 'same.txt',
      parentKey: null,
      existingMaterialId: 'existing'
    });
  });

  it('retries only catalog confirmation when all mutations already succeeded', async () => {
    const journal = new WorkspaceOperationJournal({
      actorId: 'actor',
      storage: new MemoryWorkspaceJournalStorage()
    });
    const uploadFile = vi.fn(async () => ({ state: 'succeeded', materialId: 'new-file' }));
    const confirmCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('stale'))
      .mockResolvedValue(undefined);
    const view = mount({ ensureFolder: vi.fn(), uploadFile }, journal);
    const request = {
      teamId,
      destination,
      manifest: await buildLocalManifest([{ kind: 'file' as const, file: localFile('same.txt') }]),
      confirmCatalog
    };
    await act(async () => {
      const first = await view.result.current.startUploadGroup(request);
      expect(first.state).toBe('partial');
      expect((await view.result.current.retryUploadGroup(first.id, request)).state).toBe(
        'succeeded'
      );
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(confirmCatalog).toHaveBeenNthCalledWith(2, [
      { materialId: 'new-file', driveFolderId: destination.driveFolderId }
    ]);
  });
  it.each(['canceled', 'succeeded'] as const)(
    'recovers an orphan upload and respects a %s cancellation result',
    async state => {
      const storage = new MemoryWorkspaceJournalStorage();
      const old = new WorkspaceOperationJournal({ actorId: 'actor', storage });
      const manifest = await buildLocalManifest([{ kind: 'file', file: localFile('resume.txt') }]);
      await old.accept({ id: 'orphan', teamId, destination, manifest });
      await old.checkpointItem('orphan', manifest.entries[0]!.clientItemKey, {
        state: 'running',
        operationId: 'old-op'
      });
      await old.release('orphan');
      const snapshot = {
        id: 'old-op',
        teamId,
        kind: 'upload',
        state: 'running' as const,
        stage: 'uploading',
        progress: 0,
        sourceMaterialId: null,
        resultMaterialId: null,
        errorCode: null,
        retryable: false,
        createdAt: '',
        updatedAt: ''
      };
      const cancelOperation = vi.fn(async () => ({
        ...snapshot,
        state,
        resultMaterialId: state === 'succeeded' ? 'already-done' : null
      }));
      const uploadFile = vi.fn(async () => ({ state: 'succeeded', materialId: 'new-result' }));
      const view = mount(
        {
          ensureFolder: vi.fn(),
          uploadFile,
          getOperation: vi.fn(async () => snapshot),
          cancelOperation
        },
        new WorkspaceOperationJournal({ actorId: 'actor', storage })
      );
      await waitFor(() => expect(view.result.current.groups).toHaveLength(1));
      let result!: WorkspaceOperationGroup;
      await act(async () => {
        result = await view.result.current.retryUploadGroup('orphan', {
          teamId,
          destination,
          manifest,
          confirmCatalog: async () => {}
        });
      });
      expect(cancelOperation).toHaveBeenCalledWith(teamId, 'old-op');
      expect(uploadFile).toHaveBeenCalledTimes(state === 'succeeded' ? 0 : 1);
      expect(result.state).toBe('succeeded');
    }
  );

  it('reuses a directory creation key when its successful server response was lost', async () => {
    const journal = new WorkspaceOperationJournal({
      actorId: 'actor',
      storage: new MemoryWorkspaceJournalStorage()
    });
    const ensureFolder = vi
      .fn<WorkspaceOperationsClient['ensureFolder']>()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue({ folderId: 'same-folder', materialId: 'same-material' });
    const manifest = await buildLocalManifest([
      { kind: 'directory_handle', handle: handleDirectory('empty') }
    ]);
    const view = mount({ ensureFolder, uploadFile: vi.fn() }, journal);
    const request = { teamId, destination, manifest, confirmCatalog: async () => {} };
    await act(async () => {
      const first = await view.result.current.startUploadGroup(request);
      expect(first.state).toBe('failed');
      expect((await view.result.current.retryUploadGroup(first.id, request)).state).toBe(
        'succeeded'
      );
    });
    expect(ensureFolder.mock.calls[1]![1].idempotencyKey).toBe(
      ensureFolder.mock.calls[0]![1].idempotencyKey
    );
  });
  it('creates parent folders once, preserves empty folders and confirms catalog before success', async () => {
    const ensureFolder = vi.fn(
      async (
        _team: string,
        input: { name: string; parentMaterialId: string | null; idempotencyKey: string }
      ) => ({
        folderId: `created-drive-${input.name}`,
        materialId: `created-material-${input.name}`
      })
    );
    const uploadFile = vi.fn(async () => ({ state: 'succeeded', materialId: 'file-result' }));
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
    expect(ensureFolder.mock.calls.map(([, input]) => input.idempotencyKey)).toEqual(
      expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)])
    );
    expect(new Set(ensureFolder.mock.calls.map(([, input]) => input.idempotencyKey)).size).toBe(3);
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
    const uploadFile = vi.fn(async () => ({ state: 'succeeded', materialId: 'file-result' }));
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
        await new Promise<void>(resolve => queueMicrotask(resolve));
        active -= 1;
        return { state: 'succeeded', materialId: crypto.randomUUID() };
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
    const view = mount({
      ensureFolder: vi.fn(),
      uploadFile: vi.fn(async () => ({ state: 'succeeded', materialId: 'file-result' }))
    });
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

  it('reconciles a lost finalize response after reload and does not upload the completed file again', async () => {
    let now = 1_000;
    const storage = new MemoryWorkspaceJournalStorage();
    const journal = () =>
      new WorkspaceOperationJournal({
        actorId: 'actor-one',
        storage,
        now: () => now
      });
    const ensureFolder = vi.fn(async () => ({
      folderId: 'drive-created',
      materialId: 'material-created'
    }));
    const uploadFile = vi.fn(
      async (input: Parameters<WorkspaceOperationsClient['uploadFile']>[0]) => {
        await input.onOperationAccepted?.('operation-finalized');
        throw new Error('response lost');
      }
    );
    const getOperation = vi.fn(async () => ({
      id: 'operation-finalized',
      teamId,
      kind: 'upload',
      state: 'succeeded' as const,
      stage: 'done',
      progress: 100,
      sourceMaterialId: null,
      resultMaterialId: 'material-file',
      errorCode: null,
      retryable: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }));
    const client = { ensureFolder, uploadFile, getOperation };
    const manifest = await buildLocalManifest([
      {
        kind: 'directory_handle',
        handle: handleDirectory('Project', [handleFile(localFile('a.txt', 5))])
      }
    ]);
    const first = mount(client, journal());
    let initial: WorkspaceOperationGroup | undefined;
    await act(async () => {
      initial = await first.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog: async () => undefined
      });
    });
    expect(initial?.state).toBe('partial');
    first.unmount();
    now += 31_000;
    const restored = mount(client, journal());
    await waitFor(() =>
      expect(
        restored.result.current.groups[0]?.items.find(item => item.relativePath === 'Project/a.txt')
          ?.state
      ).toBe('succeeded')
    );
    expect(getOperation).toHaveBeenCalledWith(teamId, 'operation-finalized');
    let retried: WorkspaceOperationGroup | undefined;
    await act(async () => {
      retried = await restored.result.current.retryUploadGroup(initial!.id, {
        teamId,
        destination,
        manifest: await buildLocalManifest([
          {
            kind: 'directory_handle',
            handle: handleDirectory('Project', [handleFile(new File(['other'], 'a.txt'))])
          }
        ]),
        confirmCatalog: async () => undefined
      });
    });
    expect(retried).toMatchObject({ state: 'succeeded', attempt: 2 });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(ensureFolder).toHaveBeenCalledTimes(1);
  });

  it('cancels active transfers and does not schedule waiting files', async () => {
    const uploadFile = vi.fn(
      (input: Parameters<WorkspaceOperationsClient['uploadFile']>[0]) =>
        new Promise<unknown>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true
          });
        })
    );
    const view = mount({ ensureFolder: vi.fn(), uploadFile });
    const manifest = await buildLocalManifest(
      Array.from({ length: 5 }, (_, index) => ({
        kind: 'file' as const,
        file: localFile(`file-${index}.txt`)
      }))
    );
    let pending!: Promise<WorkspaceOperationGroup>;
    act(() => {
      pending = view.result.current.startUploadGroup({
        teamId,
        destination,
        manifest,
        confirmCatalog: async () => undefined
      });
    });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(3));
    const groupId = view.result.current.groups[0]!.id;
    expect(view.result.current.cancelGroup(groupId)).toBe(true);
    let canceled: WorkspaceOperationGroup | undefined;
    await act(async () => {
      canceled = await pending;
    });
    expect(canceled?.state).toBe('canceled');
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(canceled?.items.every(item => item.state === 'canceled')).toBe(true);
    expect(view.result.current.cancelGroup(groupId)).toBe(false);
  });

  it('starts a new attempt for a changed same-size source after checking the old operation', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    const journal = new WorkspaceOperationJournal({ actorId: 'actor-one', storage });
    const uploadFile = vi.fn(
      async (input: Parameters<WorkspaceOperationsClient['uploadFile']>[0]) => {
        await input.onOperationAccepted?.(`operation-${uploadFile.mock.calls.length}`);
        if (uploadFile.mock.calls.length === 1) throw new Error('first attempt failed');
        input.onProgress?.(3, 5);
        input.onProgress?.(2, 5);
        input.onProgress?.(5, 5);
        return { state: 'succeeded', materialId: 'new-material' };
      }
    );
    const getOperation = vi.fn(async () => ({
      id: 'operation-1',
      teamId,
      kind: 'upload',
      state: 'failed' as const,
      stage: 'done',
      progress: 0,
      sourceMaterialId: null,
      resultMaterialId: null,
      errorCode: null,
      retryable: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }));
    const view = mount({ ensureFolder: vi.fn(), uploadFile, getOperation }, journal);
    const request = (file: File) => ({
      teamId,
      destination,
      confirmCatalog: async () => undefined,
      manifest: buildLocalManifest([{ kind: 'file' as const, file }])
    });
    const firstRequest = request(new File(['first'], 'same.txt'));
    let first!: WorkspaceOperationGroup;
    await act(async () => {
      first = await view.result.current.startUploadGroup({
        ...firstRequest,
        manifest: await firstRequest.manifest
      });
    });
    expect(first.state).toBe('failed');
    const changedFile = new File(['other'], 'same.txt');
    const secondRequest = request(changedFile);
    let retried!: WorkspaceOperationGroup;
    await act(async () => {
      retried = await view.result.current.retryUploadGroup(first.id, {
        ...secondRequest,
        manifest: await secondRequest.manifest
      });
    });
    expect(getOperation).toHaveBeenCalledWith(teamId, 'operation-1');
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile.mock.calls[0]![0].idempotencyKey).not.toBe(
      uploadFile.mock.calls[1]![0].idempotencyKey
    );
    expect(uploadFile.mock.calls[1]![0].file).toBe(changedFile);
    expect(retried).toMatchObject({ attempt: 2, confirmedBytes: 5, totalBytes: 5, progress: 100 });
  });
});
