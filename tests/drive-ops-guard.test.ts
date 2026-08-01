import { describe, expect, it, vi } from 'vitest';
import {
  assertExpectedSourceIdentity,
  assertTextEditEligibility,
  buildUploadConflictPlan,
  normalizeReservedName,
  postconditionForMutation,
  runVerifiedDriveSaga,
  validateLiveMutationTarget,
  validateUploadStartRequest,
  type DriveOperationMaterial,
  type LiveDriveTarget
} from '../supabase/functions/drive-ops/handler.js';

const MiB = 1024 * 1024;
const TEAM_ID = '51000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '51000000-0000-4000-8000-000000000002';
const DESTINATION_ID = '51000000-0000-4000-8000-000000000003';

function material(overrides: Partial<DriveOperationMaterial> = {}): DriveOperationMaterial {
  return {
    id: MATERIAL_ID,
    teamId: TEAM_ID,
    driveFileId: 'drive-source-1',
    parentFolderId: 'drive-folder-1',
    name: 'notes.txt',
    kind: 'file',
    lifecycle: 'active',
    mimeType: 'text/plain',
    fileExtension: 'txt',
    sizeBytes: 12,
    driveVersion: '7',
    checksum: 'checksum-7',
    transcriptIngestState: 'full',
    transcriptTruncated: false,
    ...overrides
  };
}

function live(overrides: Partial<LiveDriveTarget> = {}): LiveDriveTarget {
  return {
    id: 'drive-source-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    parents: ['drive-folder-1'],
    trashed: false,
    shortcutTargetId: null,
    sizeBytes: 12,
    driveVersion: '7',
    checksum: 'checksum-7',
    capabilities: {
      canDownload: true,
      canAddChildren: false,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: false
    },
    ...overrides
  };
}

describe('Drive operation authority and exact-target guards', () => {
  it('normalizes reservations and requires explicit exact-file conflict behavior', () => {
    expect(normalizeReservedName('  Launch   FINAL.MP4  ')).toBe('launch final.mp4');
    expect(() => normalizeReservedName('../escape.mp4')).toThrow('INVALID_INPUT');
    expect(() => normalizeReservedName('folder/file.mp4')).toThrow('INVALID_INPUT');

    const input = validateUploadStartRequest({
      teamId: TEAM_ID,
      destinationFolderId: DESTINATION_ID,
      name: ' Launch.mp4 ',
      mimeType: 'video/mp4',
      sizeBytes: 8 * MiB,
      conflictMode: 'replace',
      replaceMaterialId: MATERIAL_ID,
      idempotencyKey: 'upload-attempt-0001'
    });
    expect(input.name).toBe('Launch.mp4');
    expect(
      buildUploadConflictPlan(input, [{ materialId: MATERIAL_ID, name: 'Launch.mp4' }])
    ).toEqual({
      name: 'Launch.mp4',
      reservationKey: 'launch.mp4',
      replaceMaterialId: MATERIAL_ID
    });
    expect(() =>
      buildUploadConflictPlan({ ...input, conflictMode: 'cancel', replaceMaterialId: null }, [
        { materialId: MATERIAL_ID, name: 'Launch.mp4' }
      ])
    ).toThrow('NAME_CONFLICT');
    expect(() =>
      buildUploadConflictPlan(
        { ...input, replaceMaterialId: '51000000-0000-4000-8000-000000000099' },
        [{ materialId: MATERIAL_ID, name: 'Launch.mp4' }]
      )
    ).toThrow('NOT_FOUND');
  });

  it('keeps keep-both deterministic and forbids replace for a separate version', () => {
    const base = validateUploadStartRequest({
      teamId: TEAM_ID,
      destinationFolderId: DESTINATION_ID,
      name: 'creative.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4,
      conflictMode: 'keep_both',
      versionOfMaterialId: MATERIAL_ID,
      idempotencyKey: 'version-attempt-0001'
    });
    expect(
      buildUploadConflictPlan(base, [
        { materialId: 'a', name: 'creative.mp4' },
        { materialId: 'b', name: 'creative (2).mp4' }
      ])
    ).toEqual({
      name: 'creative (3).mp4',
      reservationKey: 'creative (3).mp4',
      replaceMaterialId: null
    });
    expect(() =>
      validateUploadStartRequest({
        ...base,
        conflictMode: 'replace',
        replaceMaterialId: MATERIAL_ID
      })
    ).toThrow('INVALID_INPUT');
  });

  it.each([
    ['rename', 'canRename'],
    ['move', 'canMoveItemWithinDrive'],
    ['text_edit', 'canModifyContent'],
    ['trash', 'canTrash'],
    ['restore', 'canUntrash']
  ] as const)('requires live ancestry and the current %s capability', (action, capability) => {
    expect(() =>
      validateLiveMutationTarget({
        action,
        target: live({
          trashed: action === 'restore',
          capabilities: { ...live().capabilities, [capability]: false }
        }),
        rootFolderId: 'drive-root',
        ancestryProven: true
      })
    ).toThrow('PERMISSION_DENIED');
    expect(() =>
      validateLiveMutationTarget({
        action,
        target: live(),
        rootFolderId: 'drive-root',
        ancestryProven: false
      })
    ).toThrow('ROOT_ESCAPE');
  });

  it('rejects shortcut bytes, root mutation, and wrong lifecycle without cached authority', () => {
    expect(() =>
      validateLiveMutationTarget({
        action: 'text_edit',
        target: live({ shortcutTargetId: 'shortcut-target' }),
        rootFolderId: 'drive-root',
        ancestryProven: true
      })
    ).toThrow('UNSUPPORTED_MEDIA');
    expect(() =>
      validateLiveMutationTarget({
        action: 'rename',
        target: live({ id: 'drive-root' }),
        rootFolderId: 'drive-root',
        ancestryProven: true
      })
    ).toThrow('PERMISSION_DENIED');
    expect(() =>
      validateLiveMutationTarget({
        action: 'rename',
        target: live({ trashed: true }),
        rootFolderId: 'drive-root',
        ancestryProven: true
      })
    ).toThrow('NOT_FOUND');
    expect(
      validateLiveMutationTarget({
        action: 'restore',
        target: live({ trashed: true, capabilities: { ...live().capabilities, canUntrash: true } }),
        rootFolderId: 'drive-root',
        ancestryProven: true
      }).id
    ).toBe('drive-source-1');
  });

  it('allows only complete bounded UTF-8 TXT and checks exact source identity before writing', () => {
    expect(assertTextEditEligibility(material(), 'hello\nworld')).toBe(11);
    for (const patch of [
      { fileExtension: 'srt' },
      { fileExtension: 'vtt' },
      { transcriptIngestState: 'truncated', transcriptTruncated: true },
      { transcriptIngestState: 'invalid_encoding' },
      { sizeBytes: MiB + 1 },
      { lifecycle: 'trashed' },
      { kind: 'shortcut' }
    ] as Array<Partial<DriveOperationMaterial>>) {
      expect(() => assertTextEditEligibility(material(patch), 'valid text')).toThrow(
        patch.sizeBytes ? 'TOO_LARGE' : 'UNSUPPORTED_MEDIA'
      );
    }
    expect(() => assertTextEditEligibility(material(), '\uD800')).toThrow('INVALID_INPUT');
    expect(() =>
      assertExpectedSourceIdentity(live({ driveVersion: '8' }), {
        driveFileId: 'drive-source-1',
        driveVersion: '7',
        checksum: 'checksum-7'
      })
    ).toThrow('SOURCE_CHANGED');
    expect(() =>
      assertExpectedSourceIdentity(live({ id: 'different-file' }), {
        driveFileId: 'drive-source-1',
        driveVersion: '7',
        checksum: 'checksum-7'
      })
    ).toThrow('SOURCE_CHANGED');
  });

  it.each([
    ['rename', live({ name: 'renamed.txt' }), { name: 'renamed.txt' }],
    ['move', live({ parents: ['new-parent'] }), { parentId: 'new-parent' }],
    ['trash', live({ trashed: true }), {}],
    ['restore', live({ trashed: false }), {}],
    ['text_edit', live({ driveVersion: '8', checksum: 'checksum-8' }), { previousVersion: '7' }]
  ] as const)('verifies the exact provider postcondition for %s', (action, result, expected) => {
    expect(postconditionForMutation(action, result, expected)).toBe(true);
  });

  it('records a reconciliation marker when Drive succeeds but the DB commit fails', async () => {
    const providerResult = live({ name: 'renamed.txt' });
    const external = vi.fn().mockResolvedValue(providerResult);
    const commit = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await expect(runVerifiedDriveSaga({ external, commit, reconcile })).rejects.toThrow(
      'DRIVE_UNAVAILABLE'
    );
    expect(external).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(providerResult);
    expect(reconcile).toHaveBeenCalledWith(providerResult);
  });
});
