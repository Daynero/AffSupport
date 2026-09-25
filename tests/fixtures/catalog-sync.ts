import type { DriveFileMetadata } from '../../supabase/functions/_shared/drive';

export function catalogFile(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: 'file',
    name: 'file.txt',
    mimeType: 'text/plain',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: false,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    size: 10,
    modifiedAt: '2026-09-24T10:00:00Z',
    version: '1',
    checksum: null,
    appProperties: {},
    ...overrides
  };
}

/** Wire fixture intentionally differs from parsed metadata. */
export function providerFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file',
    name: 'file.txt',
    mimeType: 'text/plain',
    parents: ['root'],
    trashed: false,
    capabilities: { canDownload: true },
    version: '1',
    ...overrides
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function listingPages(count: number, pageSize = 100) {
  return Array.from({ length: Math.ceil(count / pageSize) }, (_, page) => ({
    files: Array.from({ length: Math.min(pageSize, count - page * pageSize) }, (_, i) =>
      providerFile({ id: `file-${page * pageSize + i}` })
    ),
    ...(page * pageSize + pageSize < count ? { nextPageToken: `page-${page + 1}` } : {})
  }));
}
