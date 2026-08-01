import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectZip } from '../apps/agent/src/landing-preview/archive.js';
import {
  LANDING_IFRAME_SANDBOX,
  LandingPreviewOrigin,
  applyLandingValidation,
  createLandingValidationRecord,
  isAllowedPreviewNavigation,
  resolvePreviewAsset
} from '../apps/agent/src/team-bridge/preview-origin.js';
import {
  TeamPreviewBridge,
  classifyArchivePreviewError
} from '../apps/agent/src/team-bridge/preview.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('team archive and landing preview isolation', () => {
  it('rejects traversal, suspicious expansion, and protected ZIP entries with typed reasons', async () => {
    const root = await temporaryDirectory('wishly-team-preview-zip-');
    const traversal = path.join(root, 'traversal.zip');
    const bomb = path.join(root, 'bomb.zip');
    const protectedArchive = path.join(root, 'protected.zip');
    await writeFile(traversal, storedZip([{ name: '../escape.txt', contents: 'nope' }]));
    await writeFile(
      bomb,
      storedZip([{ name: 'huge.txt', contents: 'A'.repeat(2 * 1024 * 1024), compressionMethod: 8 }])
    );
    await writeFile(
      protectedArchive,
      storedZip([{ name: 'secret.txt', contents: 'secret', generalPurposeFlag: 1 }])
    );

    for (const [file, expected] of [
      [traversal, 'corrupt'],
      [bomb, 'too_large'],
      [protectedArchive, 'protected']
    ] as const) {
      let caught: unknown;
      try {
        await inspectZip(file);
      } catch (error) {
        caught = error;
      }
      expect(classifyArchivePreviewError(caught)).toBe(expected);
    }
  });

  it('binds landing promotion to the exact source identity and resets it after a change', () => {
    const record = createLandingValidationRecord({
      sourceVersion: '17',
      sourceChecksum: 'checksum-17',
      entries: [
        { path: 'index.html', directory: false, compressedSize: 12, uncompressedSize: 12, crc32: 7 }
      ],
      landingRoot: ''
    });
    expect(record.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      applyLandingValidation(
        { driveVersion: '17', checksum: 'checksum-17', category: 'archive' },
        record
      )
    ).toMatchObject({ category: 'landing', state: 'validated', version: '17' });
    expect(
      applyLandingValidation(
        { driveVersion: '18', checksum: 'checksum-18', category: 'landing' },
        record
      )
    ).toEqual({ category: 'archive', state: null, version: null, fingerprint: null });
  });

  it('serves a path-confined random origin with restrictive CSP and internal-only navigation', async () => {
    const root = await temporaryDirectory('wishly-team-landing-origin-');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    await mkdir(path.join(root, 'pages'), { recursive: true });
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><a href="pages/inside.html">Inside</a><a href="https://example.com">Outside</a>'
    );
    await writeFile(path.join(root, 'pages', 'inside.html'), '<h1>Inside</h1>');
    await writeFile(outside, 'must not be served');

    const origin = new LandingPreviewOrigin();
    const session = await origin.open({ operationId: 'preview-1', root, entryFile: 'index.html' });
    expect(new URL(session.url).hostname).toBe('127.0.0.1');
    expect(new URL(session.url).port).not.toBe('43120');
    const response = await fetch(session.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(await response.text()).toContain('wishly-preview-navigation-guard');
    expect(LANDING_IFRAME_SANDBOX).toBe('allow-scripts');
    expect(isAllowedPreviewNavigation(session.url, 'pages/inside.html')).toBe(true);
    expect(isAllowedPreviewNavigation(session.url, 'https://example.com')).toBe(false);
    await expect(resolvePreviewAsset(root, '../outside.txt')).rejects.toThrow('ROOT_ESCAPE');

    await origin.close('preview-1');
    await expect(fetch(session.url)).rejects.toThrow();
    await rm(outside, { force: true });
  });

  it('removes owned extracted content when the preview origin closes', async () => {
    const workspace = await temporaryDirectory('wishly-team-landing-cleanup-');
    const extracted = path.join(workspace, 'extracted');
    await mkdir(extracted, { recursive: true });
    await writeFile(path.join(extracted, 'index.html'), '<h1>Temporary</h1>');
    const origin = new LandingPreviewOrigin();
    await origin.open({
      operationId: 'preview-cleanup',
      root: extracted,
      entryFile: 'index.html',
      removeRootOnClose: true
    });
    await origin.close('preview-cleanup');
    await expect(access(extracted)).rejects.toThrow();
  });

  it('downloads archives in repeated bounded ranges, returns only a manifest, and cleans temp bytes', async () => {
    const temporaryRoot = await temporaryDirectory('wishly-team-preview-transfer-');
    const archive = storedZip([
      { name: 'index.html', contents: '<h1>Landing</h1>' },
      { name: 'assets/app.js', contents: 'console.log("safe fixture")' }
    ]);
    const ranges: string[] = [];
    const bridge = new TeamPreviewBridge({
      temporaryRoot,
      fetchImpl: rangeFetch(archive, ranges),
      renderer: unavailableRenderer()
    });
    await bridge.init();
    const result = await bridge.previewArchive(transferRequest('archive-ranges', 32));
    expect(result).toMatchObject({
      kind: 'archive',
      entries: [
        { path: 'index.html', directory: false },
        { path: 'assets/app.js', directory: false }
      ],
      truncated: false
    });
    expect(ranges.length).toBeGreaterThan(1);
    expect(
      ranges.every(value => {
        const match = /bytes=(\d+)-(\d+)/u.exec(value);
        return Boolean(match && Number(match[2]) - Number(match[1]) + 1 <= 32);
      })
    ).toBe(true);
    expect(
      (await readdir(temporaryRoot)).filter(name => name.startsWith('wishly-team-preview-'))
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('<h1>');
    await bridge.shutdown();
  });

  it('keeps a validated landing only for its session and removes it on close', async () => {
    const temporaryRoot = await temporaryDirectory('wishly-team-preview-landing-');
    const archive = storedZip([
      { name: 'campaign/index.html', contents: '<!doctype html><h1>Campaign</h1>' },
      { name: 'campaign/app.js', contents: 'document.body.dataset.ready = "yes"' }
    ]);
    const bridge = new TeamPreviewBridge({
      temporaryRoot,
      fetchImpl: rangeFetch(archive, []),
      renderer: unavailableRenderer()
    });
    await bridge.init();
    const result = await bridge.previewLanding(transferRequest('landing-session', 1024));
    expect(result).toMatchObject({
      kind: 'landing',
      sandbox: 'allow-scripts',
      validation: {
        sourceVersion: '17',
        sourceChecksum: 'checksum-17',
        landingRoot: 'campaign'
      }
    });
    if (result.kind !== 'landing') throw new Error('expected landing fixture');
    expect((await fetch(result.url)).status).toBe(200);
    expect(
      (await readdir(temporaryRoot)).some(name => name.startsWith('wishly-team-preview-'))
    ).toBe(true);
    expect(await bridge.close('landing-session')).toBe(true);
    expect(
      (await readdir(temporaryRoot)).filter(name => name.startsWith('wishly-team-preview-'))
    ).toEqual([]);
    await bridge.shutdown();
  });
});

function transferRequest(operationId: string, maxRangeBytes: number) {
  return {
    operationId,
    transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
    transferGrant: {
      ticket: 'opaque-preview-ticket-with-more-than-thirty-two-characters',
      purpose: 'preview_range' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxRangeBytes,
      maxUses: 512
    }
  };
}

function rangeFetch(bytes: Buffer, seenRanges: string[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range') ?? '';
    seenRanges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (!match) return new Response(null, { status: 416 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    const body = bytes.subarray(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'content-type': 'application/zip',
        'x-wishly-source-version': '17',
        'x-wishly-source-checksum': 'checksum-17'
      }
    });
  }) as typeof fetch;
}

function unavailableRenderer() {
  return {
    init: async () => {},
    availability: () => ({ available: false, error: 'fixture renderer unavailable' }),
    render: async () => {
      throw new Error('fixture renderer unavailable');
    },
    shutdown: async () => {}
  };
}

interface StoredZipInput {
  name: string;
  contents: string;
  compressedSize?: number;
  uncompressedSize?: number;
  generalPurposeFlag?: number;
  compressionMethod?: number;
}

function storedZip(entries: StoredZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed = compressionMethod === 8 ? deflateRawSync(contents) : contents;
    const encoded =
      (entry.generalPurposeFlag ?? 0) & 1
        ? Buffer.concat([Buffer.alloc(12), compressed])
        : compressed;
    const compressedSize = entry.compressedSize ?? encoded.length;
    const uncompressedSize = entry.uncompressedSize ?? contents.length;
    const flags = entry.generalPurposeFlag ?? 0;
    const local = Buffer.alloc(30 + name.length + encoded.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    encoded.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
