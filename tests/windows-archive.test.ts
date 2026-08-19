import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * The archive helpers take a different branch on Windows: macOS uses `ditto`,
 * everything else uses bsdtar (`tar.exe`, bundled since Windows 10 1803). The
 * bsdtar branch cannot be exercised by running on macOS, so these tests drive
 * bsdtar directly — the same binary and arguments the win32 branch would use —
 * and assert the round trip a Windows agent depends on.
 */
const bsdtar = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
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

describe('zip round trip on the bsdtar branch', () => {
  it('writes an archive whose single top-level entry is the directory itself', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'payload.zip');

    // zipDirectory takes the ditto branch on macOS; assert the bsdtar branch
    // produces the layout the agent's callers rely on.
    execFileSync(bsdtar, ['-a', '-cf', archive, '-C', path.dirname(payload), 'payload']);

    const entries = await listZipEntries(archive);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.startsWith('payload')).toBe(true);
    expect(entries.some(entry => entry.includes('index.html'))).toBe(true);
  });

  it('extracts the archive back to identical contents, unicode names included', async () => {
    const root = await workspace();
    const payload = await sampleTree(root);
    const archive = path.join(root, 'payload.zip');
    execFileSync(bsdtar, ['-a', '-cf', archive, '-C', path.dirname(payload), 'payload']);

    const destination = path.join(root, 'out');
    await mkdir(destination, { recursive: true });
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
