import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
import {
  CACHE_FOLDER_MARK,
  CACHE_README,
  DriveThumbnailCache,
  ensureDriveCacheRoot,
  consolidateGeneratedFolders,
  isHiddenPreviewCache,
  moveGeneratedFolderToCache
} from '../supabase/functions/_shared/drive-cache';

function metadata(id: string, over: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id,
    name: id,
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: true,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    size: null,
    modifiedAt: null,
    version: '1',
    checksum: null,
    appProperties: {},
    ...over
  };
}

function drive() {
  const files = new Map<string, DriveFileMetadata>([['root', metadata('root', { parents: [] })]]);
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  let id = 0;
  const client = {
    getFile: vi.fn(async (fileId: string) => files.get(fileId)!),
    findFolderByAppProperty: vi.fn(
      async (input: { key: string; value: string; parentId?: string }) =>
        [...files.values()].find(
          file =>
            !file.trashed &&
            file.mimeType === 'application/vnd.google-apps.folder' &&
            file.appProperties[input.key] === input.value &&
            (!input.parentId || file.parents.includes(input.parentId))
        ) ?? null
    ),
    createFolder: vi.fn(
      async (input: { name: string; parentId: string; appProperties?: Record<string, string> }) => {
        const file = metadata(`folder-${++id}`, {
          name: input.name,
          parents: [input.parentId],
          appProperties: input.appProperties ?? {}
        });
        files.set(file.id, file);
        return file;
      }
    ),
    listChildren: vi.fn(async (input: { parentId: string }) => ({
      files: [...files.values()].filter(file => file.parents.includes(input.parentId)),
      nextPageToken: null,
      incompleteSearch: false,
      invalidEntries: 0,
      complete: true
    })),
    createConvertedFile: vi.fn(
      async (input: {
        name: string;
        parentId: string;
        targetMimeType: string;
        bytes: Uint8Array<ArrayBuffer>;
        appProperties?: Record<string, string>;
      }) => {
        const file = metadata(`file-${++id}`, {
          name: input.name,
          parents: [input.parentId],
          mimeType: input.targetMimeType,
          size: input.bytes.length,
          appProperties: input.appProperties ?? {}
        });
        files.set(file.id, file);
        bytes.set(file.id, input.bytes);
        return file;
      }
    ),
    fetchFileRange: vi.fn(
      async (input: { fileId: string }) => new Response(bytes.get(input.fileId), { status: 206 })
    ),
    updateFileMetadata: vi.fn(
      async (input: { fileId: string; addParentId?: string; removeParentIds?: string[] }) => {
        const file = files.get(input.fileId)!;
        file.parents = file.parents.filter(parent => !input.removeParentIds?.includes(parent));
        if (input.addParentId) file.parents.push(input.addParentId);
        return file;
      }
    )
  };
  return { client, files, bytes };
}

const path = `ab/${'ab'.repeat(32)}.thumbnail`;

describe('connected Drive media cache', () => {
  it('creates one marked root and one explanatory README, without adopting a same-name user folder', async () => {
    const { client, files, bytes } = drive();
    files.set('user', metadata('user', { name: 'Soty Cache' }));
    const root = await ensureDriveCacheRoot(client, 'team', 'root');
    expect(await ensureDriveCacheRoot(client, 'team', 'root')).toBe(root);
    expect(root).not.toBe('user');
    expect(client.createConvertedFile).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode([...bytes.values()][0])).toBe(CACHE_README);
    expect(CACHE_README).toContain('НЕ ВИДАЛЯЙТЕ');
    expect(CACHE_README).toContain('не завжди можна відтворити');
  });

  it('keeps different connection roots isolated, even for the same team', async () => {
    const { client, files } = drive();
    files.set('other', metadata('other', { parents: [] }));
    const first = await ensureDriveCacheRoot(client, 'team', 'root');
    const second = await ensureDriveCacheRoot(client, 'team', 'other');
    expect(first).not.toBe(second);
    expect(files.get(second)?.parents).toEqual(['other']);
  });

  it('coalesces concurrent initialization and creates shared preview folders before accepting writes', async () => {
    const { client, files } = drive();
    const roots = await Promise.all(
      Array.from({ length: 5 }, () => ensureDriveCacheRoot(client, 'team', 'root'))
    );
    expect(new Set(roots).size).toBe(1);
    expect(client.createConvertedFile).toHaveBeenCalledTimes(1);
    expect([...files.values()].filter(file => file.name === 'Soty Cache')).toHaveLength(1);
    expect([...files.values()].filter(file => file.name === 'Thumbnails')).toHaveLength(1);
    expect([...files.values()].filter(file => file.name === 'Landing previews')).toHaveLength(1);
  });

  it('does not create or write anything when reading an absent cache', async () => {
    const { client } = drive();
    expect(await new DriveThumbnailCache(client, 'team', 'root').read(path)).toBeNull();
    expect(client.createFolder).not.toHaveBeenCalled();
    expect(client.createConvertedFile).not.toHaveBeenCalled();
  });

  it('stores bounded thumbnail bytes in Drive, then reads them without a duplicate upload', async () => {
    const { client, files } = drive();
    const cache = new DriveThumbnailCache(client, 'team', 'root');
    const data = new Uint8Array(128).fill(7);
    await cache.store(path, data, 'image/webp');
    await cache.store(path, data, 'image/webp');
    const result = await cache.read(path);
    expect(new Uint8Array(await result!.body.arrayBuffer())).toEqual(data);
    expect(result).toMatchObject({ mimeType: 'image/webp', contentLength: 128 });
    expect(client.createConvertedFile).toHaveBeenCalledTimes(2); // README + thumbnail
    const thumbnails = [...files.values()].find(file => file.name === 'Thumbnails')!;
    expect(isHiddenPreviewCache(thumbnails)).toBe(true);
    expect(
      isHiddenPreviewCache([...files.values()].find(file => file.name === 'Soty Cache')!)
    ).toBe(false);
  });

  it('walks to a shard once, then reads the next picture there without searching again', async () => {
    const { client } = drive();
    const cache = new DriveThumbnailCache(client, 'team-shard-memo', 'root');
    const data = new Uint8Array(64).fill(3);
    await cache.store(path, data, 'image/webp');
    await new DriveThumbnailCache(client, 'team-shard-memo', 'root').read(path);
    const searches = client.findFolderByAppProperty.mock.calls.length;
    const again = await new DriveThumbnailCache(client, 'team-shard-memo', 'root').read(path);
    expect(new Uint8Array(await again!.body.arrayBuffer())).toEqual(data);
    expect(client.findFolderByAppProperty.mock.calls.length).toBe(searches);
  });

  it('forgets a remembered shard that no longer answers and finds it again', async () => {
    const { client } = drive();
    const data = new Uint8Array(64).fill(5);
    await new DriveThumbnailCache(client, 'team-shard-stale', 'root').store(
      path,
      data,
      'image/webp'
    );
    await new DriveThumbnailCache(client, 'team-shard-stale', 'root').read(path);
    client.listChildren.mockRejectedValueOnce(new Error('404'));
    const result = await new DriveThumbnailCache(client, 'team-shard-stale', 'root').read(path);
    expect(new Uint8Array(await result!.body.arrayBuffer())).toEqual(data);
  });

  it('rejects invalid paths and oversized/non-image cache payloads before creating folders', async () => {
    const { client } = drive();
    const cache = new DriveThumbnailCache(client, 'team', 'root');
    await expect(cache.store('../../secret', new Uint8Array(128), 'image/webp')).rejects.toThrow(
      'INVALID_INPUT'
    );
    await expect(cache.store(path, new Uint8Array(5 * 1024 * 1024), 'image/webp')).rejects.toThrow(
      'INVALID_INPUT'
    );
    await expect(cache.store(path, new Uint8Array(128), 'text/html')).rejects.toThrow(
      'INVALID_INPUT'
    );
    expect(client.createFolder).not.toHaveBeenCalled();
  });

  it('rejects truncated or oversized provider responses instead of buffering unbounded media', async () => {
    const { client } = drive();
    const cache = new DriveThumbnailCache(client, 'team', 'root');
    await cache.store(path, new Uint8Array(128), 'image/webp');
    client.fetchFileRange.mockResolvedValueOnce(new Response(new Uint8Array(129), { status: 206 }));
    expect(await cache.read(path)).toBeNull();
    client.fetchFileRange.mockResolvedValueOnce(new Response(new Uint8Array(127), { status: 206 }));
    expect(await cache.read(path)).toBeNull();
  });

  it('does not create duplicate cache roots when the provider omits listing entries', async () => {
    const { client } = drive();
    client.listChildren.mockResolvedValueOnce({
      files: [],
      nextPageToken: null,
      incompleteSearch: true,
      invalidEntries: 0,
      complete: false
    });
    await expect(ensureDriveCacheRoot(client, 'team', 'root')).rejects.toThrow('INVALID_RESPONSE');
    expect(client.createConvertedFile).not.toHaveBeenCalled();
  });

  it('consolidates marked generated folders without changing IDs or moving a user folder', async () => {
    const { client, files } = drive();
    files.set(
      'video',
      metadata('video', {
        name: 'Restitched',
        appProperties: { 'soty.restitched': 'team:restitched' }
      })
    );
    files.set('user', metadata('user', { name: 'Restitched' }));
    const root = await ensureDriveCacheRoot(client, 'team', 'root');
    await consolidateGeneratedFolders(client, 'team', 'root', root);
    expect(files.get('video')?.parents).toEqual([root]);
    expect(files.get('user')?.parents).toEqual(['root']);
    await consolidateGeneratedFolders(client, 'team', 'root', root);
    expect(client.updateFileMetadata).toHaveBeenCalledTimes(1);
  });

  it('refuses to move a generated folder from outside the connected root', async () => {
    const { client, files } = drive();
    const foreign = metadata('foreign', { parents: ['outside'] });
    files.set('foreign', foreign);
    files.set('outside', metadata('outside', { parents: [] }));
    await expect(moveGeneratedFolderToCache(client, foreign, 'root', 'cache')).rejects.toThrow(
      'ROOT_ESCAPE'
    );
    expect(client.updateFileMetadata).not.toHaveBeenCalled();
  });

  it('leaves a user-owned .soty folder containing unrelated files untouched', async () => {
    const { client, files } = drive();
    files.set('user-system', metadata('user-system', { name: '.soty' }));
    files.set(
      'user-photo',
      metadata('user-photo', {
        name: 'photo.jpg',
        parents: ['user-system'],
        mimeType: 'image/jpeg'
      })
    );
    files.set('generated-system', metadata('generated-system', { name: '.soty' }));
    files.set(
      'generated-previews',
      metadata('generated-previews', { name: 'landing-previews', parents: ['generated-system'] })
    );
    const cacheId = await ensureDriveCacheRoot(client, 'team', 'root');
    await consolidateGeneratedFolders(client, 'team', 'root', cacheId);
    expect(files.get('user-system')?.parents).toEqual(['root']);
    const destination = [...files.values()].find(file => file.name === 'Landing previews')!;
    expect(files.get('generated-system')?.parents).toEqual([destination.id]);
    expect(files.get('generated-previews')?.parents).toEqual(['generated-system']);
  });

  it('identifies preview caches by app marks, not user-visible names', () => {
    expect(
      isHiddenPreviewCache(
        metadata('preview', { name: 'Renamed', appProperties: { 'soty.cache.hidden': '1' } })
      )
    ).toBe(true);
    expect(isHiddenPreviewCache(metadata('user', { name: 'Thumbnails' }))).toBe(false);
    expect(isHiddenPreviewCache(metadata('old', { name: '.soty' }))).toBe(true);
    expect(CACHE_FOLDER_MARK).toBe('soty.cache');
  });

  it('has no Supabase media write in thumbnail, poster, copy or warm routes', () => {
    for (const file of ['drive-transfer/index.ts', 'drive-ops/index.ts', 'preview-warm/index.ts']) {
      const source = readFileSync(`supabase/functions/${file}`, 'utf8');
      expect(source).not.toMatch(/\.storage[\s\S]{0,200}\.upload\(/u);
      expect(source).not.toContain('.from(THUMBNAIL_CACHE_BUCKET)');
    }
  });
});
