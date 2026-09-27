// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { buildLocalManifest } from '../apps/web/src/team/explorer/localManifest';
import {
  MemoryWorkspaceJournalStorage,
  WorkspaceOperationJournal,
  type JournalGroup
} from '../apps/web/src/team/explorer/workspaceOperationJournal';
import { handleDirectory, handleFile, localFile } from './fixtures/local-manifest';

const destination = { driveFolderId: 'drive-folder', materialId: 'material-folder' };
const actorId = 'actor-one';
const teamId = 'team-one';

async function fixture() {
  const manifest = await buildLocalManifest([
    {
      kind: 'directory_handle',
      handle: handleDirectory('Project', [handleFile(localFile('a.txt', 5))])
    }
  ]);
  return manifest;
}

describe('local workspace operation journal', () => {
  it('rejects a stale reconciliation after another owner has saved a newer checkpoint', async () => {
    let now = 1_000;
    const storage = new MemoryWorkspaceJournalStorage();
    const first = new WorkspaceOperationJournal({ actorId, storage, ownerId: 'a', now: () => now });
    const second = new WorkspaceOperationJournal({
      actorId,
      storage,
      ownerId: 'b',
      now: () => now
    });
    await first.accept({ id: 'race', teamId, destination, manifest: await fixture() });
    await first.claim('race');
    await first.checkpointItem('race', 'file:Project/a.txt:5', {
      state: 'running',
      operationId: 'op'
    });
    let resolve!: (value: Map<string, { state: 'failed' }>) => void;
    const pending = first.reconcile(
      'race',
      () =>
        new Promise(r => {
          resolve = r;
        })
    );
    await vi.waitFor(() => expect(resolve).toBeDefined());
    now += 31_000;
    expect(await second.claim('race')).toBe(true);
    await second.checkpointItem('race', 'file:Project/a.txt:5', {
      state: 'succeeded',
      resultMaterialId: 'new'
    });
    resolve(new Map([['op', { state: 'failed' }]]));
    await expect(pending).rejects.toThrow('LOCAL_OPERATION_OWNED');
    expect((await second.load(teamId))[0]?.items[1]).toMatchObject({
      state: 'succeeded',
      resultMaterialId: 'new'
    });
    await expect(first.checkpointGroup('race', { state: 'failed', stage: 'done' })).rejects.toThrow(
      'LOCAL_OPERATION_OWNED'
    );
  });

  it('does not allow a second tab to reconcile an actively owned group', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    const first = new WorkspaceOperationJournal({ actorId, storage });
    const second = new WorkspaceOperationJournal({ actorId, storage });
    await first.accept({ id: 'owned', teamId, destination, manifest: await fixture() });
    await first.claim('owned');
    await expect(second.reconcile('owned', async () => new Map())).rejects.toThrow(
      'LOCAL_OPERATION_OWNED'
    );
  });

  it('keeps the directory request key across a lost create response', async () => {
    const journal = new WorkspaceOperationJournal({
      actorId,
      storage: new MemoryWorkspaceJournalStorage()
    });
    const accepted = await journal.accept({
      id: 'folder-retry',
      teamId,
      destination,
      manifest: await fixture()
    });
    const retry = await journal.beginRetry('folder-retry', { confirmed: true });
    expect(retry.items[0]?.idempotencyKey).toBe(accepted.items[0]?.idempotencyKey);
    expect(retry.items[1]?.idempotencyKey).not.toBe(accepted.items[1]?.idempotencyKey);
  });
  it('persists only relative metadata and restores an interrupted group after reload', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    const journal = new WorkspaceOperationJournal({ actorId, storage });
    const manifest = await fixture();
    await journal.accept({ id: 'group-1', teamId, destination, manifest });
    const raw = JSON.stringify(await storage.list());
    expect(raw).toContain('Project/a.txt');
    expect(raw).not.toContain('source');
    expect(raw).not.toContain('sessionUri');
    expect(raw).not.toContain('confirmedBytes');
    const afterReload = new WorkspaceOperationJournal({ actorId, storage });
    expect((await afterReload.load(teamId))[0]).toMatchObject({
      id: 'group-1',
      state: 'interrupted_input_required',
      attempt: 1,
      destination
    });
  });

  it('same-size reselection starts a new byte-zero attempt, never the old session', async () => {
    const journal = new WorkspaceOperationJournal({
      actorId,
      storage: new MemoryWorkspaceJournalStorage()
    });
    const firstManifest = await fixture();
    const changedManifest = await buildLocalManifest([
      {
        kind: 'directory_handle',
        handle: handleDirectory('Project', [handleFile(new File(['other'], 'a.txt'))])
      }
    ]);
    expect(changedManifest.entries.map(entry => entry.clientItemKey)).toEqual(
      firstManifest.entries.map(entry => entry.clientItemKey)
    );
    await journal.accept({ id: 'group-2', teamId, destination, manifest: firstManifest });
    await journal.checkpointItem('group-2', 'file:Project/a.txt:5', {
      state: 'failed',
      operationId: 'operation-old'
    });
    await journal.reconcile(
      'group-2',
      async () => new Map([['operation-old', { state: 'failed' as const }]])
    );
    const retry = await journal.beginRetry('group-2', { confirmed: true });
    expect(retry.attempt).toBe(2);
    const item = retry.items.find(candidate => candidate.relativePath === 'Project/a.txt');
    expect(item).toMatchObject({ state: 'pending', operationId: null });
    expect(item?.idempotencyKey).not.toBe('operation-old');
    expect(JSON.stringify(retry)).not.toContain('confirmedBytes');
  });

  it('checks a lost finalize response before allowing retry and preserves success', async () => {
    const journal = new WorkspaceOperationJournal({
      actorId,
      storage: new MemoryWorkspaceJournalStorage()
    });
    await journal.accept({ id: 'group-3', teamId, destination, manifest: await fixture() });
    await journal.checkpointItem('group-3', 'file:Project/a.txt:5', {
      state: 'running',
      operationId: 'operation-finalized'
    });
    await expect(journal.beginRetry('group-3', { confirmed: true })).rejects.toThrow(
      'RECONCILE_REQUIRED'
    );
    const probe = vi.fn(
      async () =>
        new Map([
          [
            'operation-finalized',
            {
              state: 'succeeded' as const,
              resultMaterialId: 'material-result'
            }
          ]
        ])
    );
    const reconciled = await journal.reconcile('group-3', probe);
    expect(probe).toHaveBeenCalledWith(['operation-finalized']);
    expect(reconciled.items.find(item => item.relativePath === 'Project/a.txt')).toMatchObject({
      state: 'succeeded',
      resultMaterialId: 'material-result'
    });
    const retry = await journal.beginRetry('group-3', { confirmed: true });
    expect(retry.items.find(item => item.relativePath === 'Project/a.txt')?.state).toBe(
      'succeeded'
    );
  });

  it('allows only one tab to own a group until its lease expires', async () => {
    let now = 1_000;
    const storage = new MemoryWorkspaceJournalStorage();
    const first = new WorkspaceOperationJournal({
      actorId,
      storage,
      ownerId: 'tab-a',
      now: () => now
    });
    const second = new WorkspaceOperationJournal({
      actorId,
      storage,
      ownerId: 'tab-b',
      now: () => now
    });
    await first.accept({ id: 'group-4', teamId, destination, manifest: await fixture() });
    expect(await first.claim('group-4')).toBe(true);
    expect(await second.claim('group-4')).toBe(false);
    now += 31_000;
    expect(await second.claim('group-4')).toBe(true);
  });

  it('falls back to session-only recovery after quota failure', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    const journal = new WorkspaceOperationJournal({ actorId, storage });
    await journal.accept({ id: 'group-5', teamId, destination, manifest: await fixture() });
    expect(journal.sessionOnly()).toBe(true);
    expect(await journal.load(teamId)).toHaveLength(1);
    expect(await storage.list()).toHaveLength(0);
  });

  it('isolates accounts and purges only the signing-out actor', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    const first = new WorkspaceOperationJournal({ actorId, storage });
    const second = new WorkspaceOperationJournal({ actorId: 'actor-two', storage });
    await first.accept({ id: 'group-a', teamId, destination, manifest: await fixture() });
    await second.accept({ id: 'group-b', teamId, destination, manifest: await fixture() });
    expect((await first.load(teamId)).map(group => group.id)).toEqual(['group-a']);
    expect((await second.load(teamId)).map(group => group.id)).toEqual(['group-b']);
    await first.purgeActor();
    expect(await first.load(teamId)).toEqual([]);
    expect((await second.load(teamId)).map(group => group.id)).toEqual(['group-b']);
  });

  it('expires terminal metadata after seven days and interrupted metadata after thirty', async () => {
    let now = 1_000;
    const storage = new MemoryWorkspaceJournalStorage();
    const journal = new WorkspaceOperationJournal({ actorId, storage, now: () => now });
    await journal.accept({ id: 'terminal', teamId, destination, manifest: await fixture() });
    await journal.accept({ id: 'interrupted', teamId, destination, manifest: await fixture() });
    await journal.checkpointGroup('terminal', { state: 'succeeded', stage: 'done' });
    now += 8 * 24 * 60 * 60_000;
    await journal.sweep();
    expect((await journal.load(teamId)).map(group => group.id)).toEqual(['interrupted']);
    now += 23 * 24 * 60 * 60_000;
    await journal.sweep();
    expect(await journal.load(teamId)).toEqual([]);
  });

  it('ignores invalid persisted records instead of exposing unexpected fields', async () => {
    const storage = new MemoryWorkspaceJournalStorage();
    const journal = new WorkspaceOperationJournal({ actorId, storage });
    await journal.accept({ id: 'invalid', teamId, destination, manifest: await fixture() });
    const group = (await storage.get(`${actorId}\u0000invalid`)) as JournalGroup & {
      secret?: string;
    };
    group.secret = 'must-not-surface';
    await storage.put(group);
    const reloaded = new WorkspaceOperationJournal({ actorId, storage });
    expect(await reloaded.load(teamId)).toEqual([]);
  });
});
