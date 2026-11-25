import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataStripError } from '../apps/agent/src/files/strip-metadata.js';
import { TeamDownloadBridge } from '../apps/agent/src/team-bridge/download.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/*
 * 073: a picture saved through Soty arrives without its camera, place and date unless the
 * person asked for the original by name — and a file that could not be cleaned is not saved.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

const segment = (marker: number, payload: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/** A structurally complete JPEG whose EXIF names the phone. */
const phoneJpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe0, Buffer.from('JFIF\0\u0001\u0001\0\0\u0001\0\u0001\0\0', 'latin1')),
  segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\u0008\0\0\0\0\0\0iPhone 15 Pro', 'latin1')),
  segment(0xdb, Buffer.alloc(65)),
  segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
  Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9])
]);

async function setup(stripMetadata?: (file: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-073-download-'));
  roots.push(root);
  const destination = path.join(root, 'out');
  await mkdir(destination);
  const source = path.join(root, 'source.bin');
  await writeFile(source, phoneJpeg);
  const bridge = new TeamDownloadBridge({
    transfer: {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file: source,
        sizeBytes: phoneJpeg.length,
        sourceVersion: '1',
        sourceChecksum: null,
        cleanup: vi.fn().mockResolvedValue(undefined)
      })
    },
    chooseDestination: vi.fn().mockResolvedValue(destination),
    reveal: vi.fn(),
    outputFolder: async (folder: string) => {
      const named = path.join(root, 'Downloads', folder);
      await mkdir(named, { recursive: true });
      return named;
    },
    ...(stripMetadata ? { stripMetadata } : {})
  });
  const request = (metadata?: 'strip' | 'keep') => ({
    operationId: `download-${metadata ?? 'default'}`,
    transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
    transferGrant: {
      ticket: 'opaque-download-ticket-with-enough-entropy',
      purpose: 'download_range' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxRangeBytes: 4,
      maxUses: 8
    },
    fileName: 'photo.jpg',
    ...(metadata ? { metadata } : {})
  });
  return { bridge, destination, request, source, root };
}

describe('a team download through Soty (073)', () => {
  it('is clean by default, including for an older web that does not say', async () => {
    const { bridge, destination, request } = await setup();
    const saved = await bridge.download(request());
    const bytes = await readFile(path.join(destination, saved.fileName));
    expect(bytes.includes(Buffer.from('iPhone'))).toBe(false);
    expect(bytes.includes(Buffer.from('JFIF'))).toBe(true);
    expect(saved.sizeBytes).toBe(bytes.length);
  });

  it('is the original byte for byte when the person asked for metadata', async () => {
    const { bridge, destination, request } = await setup();
    const saved = await bridge.download(request('keep'));
    expect(await readFile(path.join(destination, saved.fileName))).toEqual(phoneJpeg);
  });

  it('saves a selection batch into Downloads/Soty/<folder> without asking where', async () => {
    const { bridge, request, root } = await setup();
    const saved = await bridge.download({ ...request(), saveInto: '../GN / Гвінея' });
    // One folder under Downloads/Soty, whatever the name tried to climb to.
    expect(path.dirname(saved.destination!)).toBe(
      path.join(await realpath(root), 'Downloads', 'Soty')
    );
    expect(await readdir(saved.destination!)).toEqual(['photo.jpg']);
  });

  it('leaves no file behind when the picture could not be cleaned', async () => {
    const { bridge, destination, request, source } = await setup(() =>
      Promise.reject(new MetadataStripError('jpeg-unreadable'))
    );
    await expect(bridge.download(request())).rejects.toThrow('METADATA_STRIP_FAILED');
    expect(await readdir(destination)).toEqual([]);
    // The fetched source is the app's own copy and is cleaned up as always.
    expect(await readFile(source)).toEqual(phoneJpeg);
  });
});
