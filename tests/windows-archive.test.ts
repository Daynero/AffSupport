import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listTarGzEntries,
  listZipEntries,
  extractTarGz,
  unzipArchive,
  zipDirectory
} from '../apps/agent/src/platform/platform.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * ZIP creation and extraction take a different branch on Windows so entry
 * names are independent of the console code page. The tests select that branch
 * explicitly even on macOS, then assert the round trip a Windows agent needs.
 * bsdtar remains the shared system reader for listing ZIP and tar.gz entries.
 */
const bsdtar = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
const realPlatform = process.platform;

const temporary: string[] = [];

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await Promise.all(temporary.splice(0).map(dir => removeTemporaryDirectory(dir)));
});

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-archive-'));
  temporary.push(dir);
  return dir;
}

async function sampleTree(root: string) {
  const payload = path.join(root, 'payload');
  await mkdir(path.join(payload, 'nested'), { recursive: true });
  await writeFile(path.join(payload, 'index.html'), '<!doctype html><h1>Soty</h1>');
  await writeFile(path.join(payload, 'nested', 'відео.txt'), 'unicode name');
  return payload;
}

describe('zip round trip on the Windows branch', () => {
  it('writes an archive whose single top-level entry is the directory itself', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'payload.zip');

    Object.defineProperty(process, 'platform', { value: 'win32' });
    await zipDirectory(payload, archive);
    Object.defineProperty(process, 'platform', { value: realPlatform });

    const entries = await listZipEntries(archive);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.startsWith('payload')).toBe(true);
    expect(entries.some(entry => entry.includes('index.html'))).toBe(true);
  });

  it('extracts the archive back to identical contents, unicode names included', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'payload.zip');
    const destination = path.join(root, 'out');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await zipDirectory(payload, archive);
    await unzipArchive(archive, destination);

    expect(existsSync(path.join(destination, 'payload', 'index.html'))).toBe(true);
    const unicode = path.join(destination, 'payload', 'nested', 'відео.txt');
    expect(existsSync(unicode)).toBe(true);
    expect(await readFile(unicode, 'utf8')).toBe('unicode name');
  });

  it('rejects a corrupt archive instead of silently producing nothing', async () => {
    const root = await workspace();
    const archive = path.join(root, 'broken.zip');
    await writeFile(archive, 'this is not a zip file');
    await expect(listZipEntries(archive)).rejects.toThrow();
  });
});

describe('tar.gz handling, shared by both platforms', () => {
  it('lists and extracts a gzipped tarball', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'payload.tar.gz');
    execFileSync(bsdtar, ['-czf', archive, '-C', path.dirname(payload), 'payload']);

    const entries = await listTarGzEntries(archive);
    expect(entries.some(entry => entry.includes('index.html'))).toBe(true);

    const destination = path.join(root, 'out');
    await mkdir(destination, { recursive: true });
    await extractTarGz(archive, destination);
    expect(existsSync(path.join(destination, 'payload', 'index.html'))).toBe(true);
  });
});

describe('zipDirectory on the current platform', () => {
  it('produces an archive the matching reader can list', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'made.zip');

    await zipDirectory(payload, archive);

    const entries = await listZipEntries(archive);
    expect(entries.some(entry => entry.includes('index.html'))).toBe(true);
  });
});
