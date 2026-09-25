import { describe, expect, it } from 'vitest';
import {
  isCatalogSyncPhase,
  isCatalogSyncJobKind,
  isCatalogCoverageState,
  parseFolderSyncStatus
} from '../packages/shared/src/team/transport';

describe('sync boundaries', () => {
  it('accepts only closed phase, kind and coverage states', () => {
    expect(isCatalogSyncPhase('initial_scan')).toBe(true);
    expect(isCatalogSyncPhase('done-ish')).toBe(false);
    expect(isCatalogSyncJobKind('discovered_subtree')).toBe(true);
    expect(isCatalogSyncJobKind(null)).toBe(false);
    expect(isCatalogCoverageState('permission_limited')).toBe(true);
    expect(isCatalogCoverageState('ready')).toBe(false);
  });
  it('rejects unsafe status counts, unknown states and secret-bearing payloads', () => {
    const valid = {
      jobId: 'job',
      scopeFolderId: 'folder',
      state: 'running',
      phase: 'listing',
      discoveredFiles: 0,
      completedFolders: 0,
      pendingFolders: null,
      lastProgressAt: null,
      completedAt: null,
      errorCode: null
    };
    expect(parseFolderSyncStatus(valid)).toEqual(valid);
    expect(parseFolderSyncStatus({ ...valid, discoveredFiles: -1 })).toBeNull();
    expect(parseFolderSyncStatus({ ...valid, state: 'whatever' })).toBeNull();
    expect(parseFolderSyncStatus({ ...valid, leaseOwner: 'secret' })).toBeNull();
    expect(parseFolderSyncStatus({ ...valid, pendingFolders: Infinity })).toBeNull();
    expect(parseFolderSyncStatus(null)).toBeNull();
  });
});
