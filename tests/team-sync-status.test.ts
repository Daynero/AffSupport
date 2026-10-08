import { describe, expect, it } from 'vitest';
import { parseFolderSyncStatus, summarize } from '../apps/web/src/team/syncStatus';

/**
 * 028, release B — the web's own boundary for the detailed sync status. It
 * accepts every state the server can report, fills the counters the older
 * server does not send, and refuses anything that is not part of the contract.
 */

const full = {
  jobId: 'job',
  requestId: 'req',
  scopeFolderId: 'docs',
  state: 'running',
  phase: 'listing',
  blockedReason: null,
  errorCode: null,
  errorDetail: null,
  nextAttemptAt: null,
  startedAt: '2026-10-07T10:00:00Z',
  lastProgressAt: '2026-10-07T10:01:00Z',
  scanCompletedAt: null,
  completedAt: null,
  filesListed: 10,
  filesAdded: 2,
  filesUpdated: 1,
  filesRemoved: 0,
  itemsUnavailable: 0,
  foldersDone: 3,
  pendingFolders: 2,
  coverage: 'unknown',
  progressRevision: 3,
  cancelable: true,
  sharedWith: 1,
  discoveredFiles: 10,
  completedFolders: 3
};

describe('parseFolderSyncStatus', () => {
  it('accepts every state and blocked reason', () => {
    for (const state of [
      'queued',
      'running',
      'retry_wait',
      'blocked',
      'canceling',
      'canceled',
      'succeeded',
      'failed'
    ]) {
      expect(parseFolderSyncStatus({ ...full, state })?.state).toBe(state);
    }
    for (const reason of ['canonical_failed', 'canonical_retrying', 'needs_reauth']) {
      expect(parseFolderSyncStatus({ ...full, blockedReason: reason })?.blockedReason).toBe(reason);
    }
  });

  it('fills counters the release-A server leaves out and maps the old aliases', () => {
    const legacy = parseFolderSyncStatus({
      jobId: 'job',
      scopeFolderId: '__root__',
      state: 'queued',
      phase: 'listing',
      discoveredFiles: 7,
      completedFolders: 1,
      pendingFolders: null,
      lastProgressAt: null,
      completedAt: null,
      errorCode: null
    });
    expect(legacy).toMatchObject({
      filesListed: 7,
      foldersDone: 1,
      filesAdded: 0,
      progressRevision: 0,
      cancelable: false,
      sharedWith: 0,
      coverage: 'unknown',
      requestId: null
    });
  });

  it('refuses an unknown state, phase or reason and any private field', () => {
    expect(parseFolderSyncStatus({ ...full, state: 'leased' })).toBeNull();
    expect(parseFolderSyncStatus({ ...full, phase: 'incremental' })).toBeNull();
    expect(parseFolderSyncStatus({ ...full, blockedReason: 'because' })).toBeNull();
    expect(parseFolderSyncStatus({ ...full, cursor: { pageToken: 'x' } })).toBeNull();
    expect(parseFolderSyncStatus({ ...full, folder_queue: [] })).toBeNull();
    expect(parseFolderSyncStatus({ ...full, filesAdded: -1 })).toBeNull();
    expect(parseFolderSyncStatus(null)).toBeNull();
  });
});

describe('summarize', () => {
  it('says what changed, that nothing changed, or that the result is partial', () => {
    const base = parseFolderSyncStatus({ ...full, state: 'succeeded', phase: 'done' })!;
    expect(summarize(base)).toEqual({
      kind: 'changes',
      added: 2,
      updated: 1,
      removed: 0,
      unavailable: 0
    });
    expect(summarize({ ...base, filesAdded: 0, filesUpdated: 0 })).toEqual({
      kind: 'none',
      unavailable: 0
    });
    expect(summarize({ ...base, itemsUnavailable: 3 })).toMatchObject({
      kind: 'partial',
      unavailable: 3
    });
    expect(summarize({ ...base, coverage: 'permission_limited' })).toMatchObject({
      kind: 'partial'
    });
  });
});
