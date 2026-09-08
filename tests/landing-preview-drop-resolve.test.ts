import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDroppedFolder, findDroppedSource } from '../apps/agent/src/files/dropped-source.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

/** Seed a folder under a fake home's Downloads and describe one file inside it as a drop sample. */
async function seedDrop(folderName: string, relPath: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'drop-home-'));
  roots.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const root = path.join(home, 'Downloads', folderName);
  const file = path.join(root, ...relPath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'hello landing');
  const details = await stat(file);
  return { root, size: details.size, lastModified: details.mtimeMs };
}

describe('findDroppedFolder', () => {
  it('recovers a video nested under Downloads before it falls back to an import copy', async () => {
    const seed = await seedDrop('campaign', 'exports/video.mp4');
    const file = path.join(seed.root, 'exports', 'video.mp4');
    const resolved = await findDroppedSource('video.mp4', seed.size, seed.lastModified);

    expect(resolved).toBe(file);
  });

  it('recovers a folder dropped into a common location from a top-level sample file', async () => {
    const seed = await seedDrop('promo', 'index.html');
    const resolved = await findDroppedFolder({
      folderName: 'promo',
      relPath: 'index.html',
      fileName: 'index.html',
      size: seed.size,
      lastModified: seed.lastModified
    });
    expect(resolved).toBe(seed.root);
  });

  it('recovers a folder from a nested sample file', async () => {
    const seed = await seedDrop('promo', 'landing-a/index.html');
    const resolved = await findDroppedFolder({
      folderName: 'promo',
      relPath: 'landing-a/index.html',
      fileName: 'index.html',
      size: seed.size,
      lastModified: seed.lastModified
    });
    expect(resolved).toBe(seed.root);
  });

  it('returns null when the sample file size does not match', async () => {
    const seed = await seedDrop('promo', 'index.html');
    const resolved = await findDroppedFolder({
      folderName: 'promo',
      relPath: 'index.html',
      fileName: 'index.html',
      size: seed.size + 1,
      lastModified: seed.lastModified
    });
    expect(resolved).toBeNull();
  });

  it('rejects path traversal in the sample relative path', async () => {
    const seed = await seedDrop('promo', 'index.html');
    const resolved = await findDroppedFolder({
      folderName: 'promo',
      relPath: '../secrets.txt',
      fileName: 'secrets.txt',
      size: seed.size,
      lastModified: seed.lastModified
    });
    expect(resolved).toBeNull();
  });
});
