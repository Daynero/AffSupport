import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient, type DriveFileMetadata } from '../supabase/functions/_shared/drive';
import {
  DRIVE_IMAGE_PROBE_BATCH,
  DRIVE_IMAGE_SETTLE_MS,
  driveImageProbes,
  recordDriveImageProbes
} from '../supabase/functions/catalog-sync/image-probes';

/**
 * What a catalog scan tells the database about the pictures it listed (2026-11-26): the
 * dimensions Drive read, and — only once Drive has had time — that it read none. The note is
 * taken beside the scan, never as part of it.
 */

const TOKEN = 'ya29.test-access-token-with-enough-length';
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const md5 = (seed: number) => seed.toString(16).padStart(32, '0');

function raw(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'photo.png',
    mimeType: 'image/png',
    parents: ['folder'],
    trashed: false,
    capabilities: { canDownload: true },
    size: '2048',
    version: '3',
    md5Checksum: md5(1),
    modifiedTime: '2020-01-01T00:00:00.000Z',
    createdTime: '2026-11-26T10:00:00.000Z',
    ...overrides
  };
}

async function listed(files: unknown[]): Promise<{ files: DriveFileMetadata[]; url: URL }> {
  const fetchImpl = vi.fn(
    async (_url: URL) =>
      new Response(JSON.stringify({ files }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  );
  const drive = new GoogleDriveClient(TOKEN, fetchImpl as unknown as typeof fetch);
  const page = await drive.listChildren({ parentId: 'folder' });
  return { files: page.files, url: new URL(String(fetchImpl.mock.calls[0]![0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the Drive client asks for and reads', () => {
  it('asks every listing for the dimensions and the day Drive first held the file', async () => {
    const { url } = await listed([raw()]);
    const fields = url.searchParams.get('fields') ?? '';
    expect(fields).toContain('imageMediaMetadata(width,height)');
    expect(fields).toContain('createdTime');
  });

  it('reads both dimensions or none', async () => {
    const { files } = await listed([
      raw({ id: 'real', imageMediaMetadata: { width: 1080, height: 1920 } }),
      raw({ id: 'companion', name: '._photo.png', size: '180' }),
      raw({ id: 'half', imageMediaMetadata: { width: 1080 } }),
      raw({ id: 'zero', imageMediaMetadata: { width: 0, height: 0 } }),
      raw({ id: 'text', imageMediaMetadata: { width: '1080', height: '1920' } })
    ]);
    expect(files.map(file => [file.id, file.imageSize ?? null])).toEqual([
      ['real', { width: 1080, height: 1920 }],
      ['companion', null],
      ['half', null],
      ['zero', null],
      ['text', null]
    ]);
    expect(files[0]!.createdAt).toBe('2026-11-26T10:00:00.000Z');
    // A file without the fields reads exactly as it did before they were asked for.
    expect(Object.hasOwn(files[1]!, 'imageSize')).toBe(false);
  });
});

function file(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: 'file-1',
    name: 'photo.png',
    mimeType: 'image/png',
    parents: ['folder'],
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
      canShare: true,
      canTrash: true,
      canUntrash: true
    },
    size: 2048,
    modifiedAt: '2020-01-01T00:00:00.000Z',
    version: '3',
    checksum: md5(1),
    createdAt: new Date(NOW - DRIVE_IMAGE_SETTLE_MS).toISOString(),
    appProperties: {},
    ...overrides
  };
}

describe('the probes of one page', () => {
  it('carries the dimensions Drive gave', () => {
    expect(driveImageProbes([file({ imageSize: { width: 1080, height: 1920 } })], NOW)).toEqual([
      { driveFileId: 'file-1', checksum: md5(1), width: 1080, height: 1920, settled: true }
    ]);
  });

  it('calls silence settled only when Drive has held the file for the whole window', () => {
    const at = (age: number) =>
      driveImageProbes([file({ createdAt: new Date(NOW - age).toISOString() })], NOW)[0]!;
    expect(at(DRIVE_IMAGE_SETTLE_MS)).toMatchObject({ width: null, height: null, settled: true });
    expect(at(DRIVE_IMAGE_SETTLE_MS - 1).settled).toBe(false);
    // The uploader's clock is not Drive's: an old modified time proves nothing.
    expect(driveImageProbes([file({ createdAt: null })], NOW)[0]!.settled).toBe(false);
    expect(driveImageProbes([file({ createdAt: 'yesterday' })], NOW)[0]!.settled).toBe(false);
    expect(
      driveImageProbes([file({ createdAt: new Date(NOW + 60_000).toISOString() })], NOW)[0]!.settled
    ).toBe(false);
  });

  it('takes only files a screen pool could hold', () => {
    const probes = driveImageProbes(
      [
        file({ id: 'png' }),
        file({ id: 'jpeg', mimeType: 'image/jpeg' }),
        file({ id: 'webp', mimeType: 'IMAGE/WEBP' }),
        file({ id: 'gif', mimeType: 'image/gif' }),
        file({ id: 'video', mimeType: 'video/mp4' }),
        file({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' }),
        file({ id: 'trashed', trashed: true }),
        file({ id: 'shortcut', shortcutTargetId: 'target' }),
        file({ id: 'no-checksum', checksum: null }),
        file({ id: 'odd-checksum', checksum: 'md5-17' })
      ],
      NOW
    );
    expect(probes.map(probe => probe.driveFileId)).toEqual(['png', 'jpeg', 'webp']);
  });
});

describe('writing them down', () => {
  it('sends the probes of a page in bounded batches and adds up what was written', async () => {
    const files = Array.from({ length: DRIVE_IMAGE_PROBE_BATCH + 5 }, (_, index) =>
      file({ id: `file-${index}`, checksum: md5(index + 1) })
    );
    const rpc = vi.fn(async (_name: string, parameters: Record<string, unknown>) => ({
      data: (parameters.p_probes as unknown[]).length,
      error: null
    }));
    expect(await recordDriveImageProbes({ rpc }, 'connection-1', files, NOW)).toBe(
      DRIVE_IMAGE_PROBE_BATCH + 5
    );
    expect(rpc.mock.calls.map(call => [call[0], (call[1].p_probes as unknown[]).length])).toEqual([
      ['service_record_drive_image_probes', DRIVE_IMAGE_PROBE_BATCH],
      ['service_record_drive_image_probes', 5]
    ]);
    expect(rpc.mock.calls[0]![1].p_connection).toBe('connection-1');
  });

  it('asks the database nothing for a page without pictures', async () => {
    const rpc = vi.fn();
    expect(
      await recordDriveImageProbes({ rpc }, 'connection-1', [file({ mimeType: 'video/mp4' })], NOW)
    ).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never fails the scan: a database without the function, or one that does not answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missing = vi.fn(async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function with a secret in it' }
    }));
    expect(await recordDriveImageProbes({ rpc: missing }, 'connection-1', [file()], NOW)).toBe(0);
    const broken = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await recordDriveImageProbes({ rpc: broken }, 'connection-1', [file()], NOW)).toBe(0);
    // The log names a code and nothing a database could have echoed back.
    expect(warn.mock.calls).toEqual([
      ['catalog_sync_image_probes_skipped', { code: 'PGRST202' }],
      ['catalog_sync_image_probes_skipped', { code: null }]
    ]);
  });
});
