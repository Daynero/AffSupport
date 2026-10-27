import { describe, expect, it, vi } from 'vitest';
import { createCatalogImageDriveSources } from '../supabase/functions/catalog-images/drive-sources';
import type { DriveFileMetadata, DriveListingPage } from '../supabase/functions/_shared/drive';

const TEAM = '45000000-0000-4000-8000-000000000001';
const ACTOR = '45000000-0000-4000-8000-000000000002';
const MATERIAL = '45000000-0000-4000-8000-000000000003';
const OTHER_MATERIAL = '45000000-0000-4000-8000-000000000004';
const CREDENTIAL = '45000000-0000-4000-8000-000000000005';
const signal = () => new AbortController().signal;
function file(id: string, extra: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id,
    name: `${id}.png`,
    mimeType: 'image/png',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canShare: true,
      canListChildren: true,
      canAddChildren: false,
      canRename: false,
      canMoveItemWithinDrive: false,
      canMoveItemOutOfDrive: false,
      canModifyContent: false,
      canTrash: false,
      canUntrash: false
    },
    size: 3,
    modifiedAt: null,
    version: '1',
    checksum: 'abc',
    appProperties: {},
    ...extra
  };
}
function folder(id: string): DriveFileMetadata {
  return file(id, { mimeType: 'application/vnd.google-apps.folder', size: null });
}
function page(files: DriveFileMetadata[], nextPageToken: string | null = null): DriveListingPage {
  return {
    files,
    nextPageToken,
    complete: nextPageToken === null,
    incompleteSearch: false,
    invalidEntries: 0
  };
}
function setup() {
  const files = new Map<string, DriveFileMetadata>([
    ['image', file('image')],
    ['root', folder('root')]
  ]);
  const getFile = vi.fn(async (id: string) => {
    const result = files.get(id);
    if (!result) throw new Error(`Missing synthetic metadata: ${id}`);
    return result;
  });
  const listChildren = vi.fn(
    async (_input: { parentId: string; pageToken?: string | null; driveId?: string | null }) =>
      page([])
  );
  const mutation = vi.fn(async () => {
    throw new Error('Drive mutation is forbidden');
  });
  const drive = {
    getFile,
    listChildren,
    createFile: mutation,
    updateFileMetadata: mutation,
    createPermission: mutation
  };
  const context = vi.fn(
    async (_team: string, _actor: string, _material: string): Promise<Record<string, unknown>> => ({
      root_folder_id: 'root',
      credential_id: CREDENTIAL,
      drive_file_id: 'image'
    })
  );
  const token = vi.fn(async (_credential: string) => 'synthetic-token');
  const fetchMedia = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } })
  );
  const createDrive = vi.fn(async (_credential: string, _signal: AbortSignal) => drive);
  const sources = createCatalogImageDriveSources({
    context,
    token,
    drive: createDrive,
    fetchMedia
  });
  const source = {
    rootMaterialId: MATERIAL,
    rootId: 'root',
    credentialId: CREDENTIAL,
    fileId: 'image',
    resourceKey: 'resource-key',
    version: '1',
    checksum: 'abc',
    size: 3
  };
  const claim = (cursor: unknown[] = [MATERIAL], admittedCount = 0, admittedBytes = 0) => ({
    teamId: TEAM,
    actorId: ACTOR,
    cursor,
    admittedCount,
    admittedBytes
  });
  return {
    files,
    getFile,
    listChildren,
    mutation,
    context,
    token,
    fetchMedia,
    createDrive,
    sources,
    source,
    claim
  };
}

describe('catalog image Drive source reads', () => {
  it('proves live ancestry and permission before and after bounded bytes without Drive mutations', async () => {
    const f = setup();
    expect(await f.sources.readDrive(f.source, ACTOR, TEAM, signal())).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(f.context.mock.calls).toEqual([
      [TEAM, ACTOR, MATERIAL],
      [TEAM, ACTOR, MATERIAL]
    ]);
    expect(f.getFile.mock.calls).toEqual([
      ['image', undefined],
      ['image', undefined]
    ]);
    const [input, init] = f.fetchMedia.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.searchParams.get('alt')).toBe('media');
    expect(url.searchParams.get('resourceKey')).toBe('resource-key');
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer synthetic-token' }
    });
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each(['version', 'checksum', 'size'] as const)(
    'rejects changed %s before reading media',
    async field => {
      const f = setup();
      f.files.set('image', file('image', { [field]: field === 'size' ? 4 : 'changed' }));
      await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
        'IMAGE_SOURCE_CHANGED'
      );
      expect(f.fetchMedia).not.toHaveBeenCalled();
    }
  );
  it.each(['version', 'checksum', 'size'] as const)(
    'rejects changed %s after the media response',
    async field => {
      const f = setup();
      f.fetchMedia.mockImplementationOnce(async () => {
        f.files.set('image', file('image', { [field]: field === 'size' ? 4 : 'changed' }));
        return new Response(new Uint8Array([1, 2, 3]));
      });
      await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
        'IMAGE_SOURCE_CHANGED'
      );
      expect(f.fetchMedia).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['root_folder_id', 'credential_id'])(
    'rejects changed current %s after reading media',
    async field => {
      const f = setup();
      f.context
        .mockResolvedValueOnce({
          root_folder_id: 'root',
          credential_id: CREDENTIAL,
          drive_file_id: 'image'
        })
        .mockResolvedValueOnce({
          root_folder_id: 'root',
          credential_id: CREDENTIAL,
          drive_file_id: 'image',
          [field]: 'changed'
        });
      await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
        'IMAGE_SOURCE_CHANGED'
      );
    }
  );
  it('rejects initial root rebinding before media access', async () => {
    const f = setup();
    f.context.mockResolvedValue({
      root_folder_id: 'other-root',
      credential_id: CREDENTIAL,
      drive_file_id: 'image'
    });
    await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
      'IMAGE_SOURCE_CHANGED'
    );
    expect(f.fetchMedia).not.toHaveBeenCalled();
  });
  it('does not trust stored ancestry or restored permission after an authorization rejection', async () => {
    const f = setup();
    f.files.set('image', file('image', { parents: [] }));
    await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
      'ROOT_ESCAPE'
    );
    expect(f.fetchMedia).not.toHaveBeenCalled();
    f.context.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
      'PERMISSION_DENIED'
    );
  });
  it.each(['canDownload', 'canShare'] as const)(
    'requires current %s before and after media',
    async capability => {
      const f = setup();
      const denied = file('image');
      denied.capabilities[capability] = false;
      f.files.set('image', denied);
      await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
        'PERMISSION_DENIED'
      );
      expect(f.fetchMedia).not.toHaveBeenCalled();
      f.files.set('image', file('image'));
      f.fetchMedia.mockImplementationOnce(async () => {
        f.files.set('image', denied);
        return new Response(new Uint8Array([1, 2, 3]));
      });
      await expect(f.sources.readDrive(f.source, ACTOR, TEAM, signal())).rejects.toThrow(
        'PERMISSION_DENIED'
      );
      expect(f.mutation).not.toHaveBeenCalled();
    }
  );
});

describe('catalog image Drive traversal', () => {
  it('deduplicates overlapping roots across persisted cursors and retains file identity', async () => {
    const f = setup();
    const first = await f.sources.enumerateDrive(f.claim([MATERIAL, OTHER_MATERIAL]), signal());
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      fileId: 'image',
      source: { version: '1', checksum: 'abc', rootMaterialId: MATERIAL }
    });
    const replay = await f.sources.enumerateDrive(
      f.claim([...first.cursor, OTHER_MATERIAL], 1, 3),
      signal()
    );
    expect(replay.entries).toHaveLength(0);
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.fetchMedia).not.toHaveBeenCalled();
  });
  it('persists unconsumed children and provider page tokens when invocation work is bounded', async () => {
    const f = setup();
    f.context.mockResolvedValue({
      root_folder_id: 'root',
      credential_id: CREDENTIAL,
      drive_file_id: 'root'
    });
    const children = Array.from({ length: 9 }, (_, i) => file(`child-${i}`));
    children.forEach(child => f.files.set(child.id, child));
    f.files.set('last', file('last'));
    f.listChildren.mockImplementation(async input =>
      input.pageToken === 'next' ? page([f.files.get('last')!]) : page(children, 'next')
    );
    const first = await f.sources.enumerateDrive(f.claim(), signal());
    expect(first.complete).toBe(false);
    expect(first.more).toBe(false);
    expect(first.entries).toHaveLength(7);
    expect(first.cursor).toContainEqual({
      rootMaterialId: MATERIAL,
      fileId: 'root',
      pageToken: 'next'
    });
    const second = await f.sources.enumerateDrive(f.claim(first.cursor, 7, 21), signal());
    expect(second.complete).toBe(true);
    expect(second.entries).toHaveLength(3);
    expect(f.listChildren).toHaveBeenCalledWith({
      parentId: 'root',
      pageToken: 'next',
      driveId: null
    });
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.fileId)).size).toBe(10);
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.fetchMedia).not.toHaveBeenCalled();
  });
  it('retains a continuation boundary when the job file quota is reached', async () => {
    const f = setup();
    const result = await f.sources.enumerateDrive(f.claim([MATERIAL], 1000, 3000), signal());
    expect(result).toMatchObject({ entries: [], complete: true, more: true });
    expect(result.cursor).toContainEqual({ rootMaterialId: MATERIAL });
  });
  it.each(['incompleteSearch', 'invalidEntries'] as const)(
    'refuses incomplete listing evidence %s',
    async field => {
      const f = setup();
      f.context.mockResolvedValue({
        root_folder_id: 'root',
        credential_id: CREDENTIAL,
        drive_file_id: 'root'
      });
      f.listChildren.mockResolvedValue({
        ...page([]),
        [field]: field === 'invalidEntries' ? 1 : true
      });
      await expect(f.sources.enumerateDrive(f.claim(), signal())).rejects.toThrow(
        'IMAGE_SOURCE_UNAVAILABLE'
      );
    }
  );
  it('requires live folder listing permission and rejects explicit non-image sources', async () => {
    const f = setup();
    const root = folder('root');
    root.capabilities.canListChildren = false;
    f.files.set('root', root);
    f.context.mockResolvedValue({
      root_folder_id: 'root',
      credential_id: CREDENTIAL,
      drive_file_id: 'root'
    });
    await expect(f.sources.enumerateDrive(f.claim(), signal())).rejects.toThrow(
      'PERMISSION_DENIED'
    );
    expect(f.listChildren).not.toHaveBeenCalled();
    f.context.mockResolvedValue({
      root_folder_id: 'root',
      credential_id: CREDENTIAL,
      drive_file_id: 'image'
    });
    f.files.set('image', file('image', { mimeType: 'text/plain' }));
    await expect(f.sources.enumerateDrive(f.claim(), signal())).rejects.toThrow(
      'IMAGE_UNSUPPORTED_FORMAT'
    );
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
