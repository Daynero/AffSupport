import { describe, expect, it } from 'vitest';
import {
  isFolderPage,
  isStorageHealth,
  isTeamDriveSelection,
  isTeamFolderNode,
  isTeamMaterialRow,
  isThumbnailSession
} from '../packages/shared/src/team/index';

/**
 * Feature 011 (T017): what the browser accepts from the explorer reads. A row
 * that is missing a field the interface renders is refused at the boundary,
 * not rendered as `undefined`.
 */

const row = {
  id: '9d9c5b5f-2b6b-4c22-9a7e-3d2b1c0a0001',
  teamId: '9d9c5b5f-2b6b-4c22-9a7e-3d2b1c0a0002',
  name: 'Banner.png',
  category: 'image',
  mimeType: 'image/png',
  fileExtension: 'png',
  sizeBytes: 1024,
  kind: 'image',
  driveFileId: 'drive-1',
  parentFolderId: 'root',
  modifiedAt: '2026-08-27T00:00:00.000Z',
  driveVersion: '3',
  previewState: 'ready',
  thumbnailReady: true
};

describe('explorer boundary guards', () => {
  it('accepts a well-formed material row and refuses one missing a nullable field', () => {
    expect(isTeamMaterialRow(row)).toBe(true);
    expect(isTeamMaterialRow({ ...row, landingRender: { state: 'ready' } })).toBe(true);
    expect(isTeamMaterialRow({ ...row, landingRender: { state: 'sideways' } })).toBe(false);
    const withoutParent = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'parentFolderId')
    );
    expect(isTeamMaterialRow(withoutParent)).toBe(false);
    expect(isTeamMaterialRow({ ...row, kind: 'spreadsheet' })).toBe(false);
    expect(isTeamMaterialRow({ ...row, previewState: 'maybe' })).toBe(false);
  });

  it('accepts a page with a null or well-formed cursor only', () => {
    expect(isFolderPage({ rows: [row], total: 1, next: null })).toBe(true);
    expect(isFolderPage({ rows: [row], total: 5, next: { sortKey: '1|x', id: 'a' } })).toBe(true);
    expect(isFolderPage({ rows: [row], total: -1, next: null })).toBe(false);
    expect(isFolderPage({ rows: [{}], total: 1, next: null })).toBe(false);
    expect(isFolderPage({ rows: [], total: 0, next: { sortKey: 1 } })).toBe(false);
  });

  it('narrows folder nodes, selections and thumbnail sessions', () => {
    expect(
      isTeamFolderNode({
        id: 'a',
        driveFileId: 'f',
        parentFolderId: null,
        selectionId: null,
        name: 'Alpha',
        indexedAt: null,
        childFolderCount: 0,
        childFileCount: 2,
        thumbnailReadyCount: 1
      })
    ).toBe(true);
    expect(isTeamFolderNode({ id: 'a', driveFileId: 'f', name: 'x' })).toBe(false);
    expect(
      isTeamDriveSelection({
        id: 'a',
        driveFolderId: 'f',
        name: 'Root',
        isRoot: true,
        state: 'active'
      })
    ).toBe(true);
    expect(
      isTeamDriveSelection({
        id: 'a',
        driveFolderId: 'f',
        name: 'Root',
        isRoot: true,
        state: 'gone'
      })
    ).toBe(false);
    const endpoint = 'https://p.supabase.co/functions/v1/drive-transfer/thumbnail';
    expect(isThumbnailSession({ token: 't', expiresAt: 'x', teamId: 'y', endpoint })).toBe(true);
    expect(isThumbnailSession({ token: '', expiresAt: 'x', teamId: 'y', endpoint })).toBe(false);
    expect(isThumbnailSession({ token: 't', expiresAt: 'x', teamId: 'y' })).toBe(false);
  });

  it('accepts exactly one storage health shape per kind', () => {
    expect(isStorageHealth({ kind: 'connected', lastReconciledAt: 'now' })).toBe(true);
    expect(
      isStorageHealth({ kind: 'indexing', indexedFolders: 3, totalFolders: null, files: 9 })
    ).toBe(true);
    expect(isStorageHealth({ kind: 'preparing', ready: 1, pending: 2 })).toBe(true);
    expect(isStorageHealth({ kind: 'waiting_provider', since: 'now' })).toBe(true);
    expect(isStorageHealth({ kind: 'attention', reason: 'root_missing', fixer: 'owner' })).toBe(
      true
    );
    expect(isStorageHealth({ kind: 'attention', reason: 'password', fixer: 'owner' })).toBe(false);
    expect(isStorageHealth({ kind: 'disconnected' })).toBe(true);
    expect(isStorageHealth({ kind: 'connected' })).toBe(false);
    expect(isStorageHealth({ kind: 'lost' })).toBe(false);
  });
});
