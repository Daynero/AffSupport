import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LandingPreviewStore } from '../apps/agent/src/landing/previews.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('landing preview store', () => {
  it('serves only registered before/after pairs by generated asset id', async () => {
    const workspace = await temporaryWorkspace();
    const source = path.join(workspace, 'hero.png');
    await writeFile(source, Buffer.from('original-pixels'));
    const optimized = Buffer.from('optimized-pixels');
    const id = randomUUID();
    const store = new LandingPreviewStore();
    store.useWorkspace(workspace);

    expect(await store.cache(id, source, optimized, 1200, 800)).toBe(true);
    expect(store.metadata(id)).toEqual({ comparison: true, width: 1200, height: 800 });

    const before = await store.content(id, 'before', 'full');
    const after = await store.content(id, 'after', 'full');
    expect(before?.mimeType).toBe('image/png');
    expect(after?.mimeType).toBe('image/webp');
    expect(before && (await readFile(before.filePath)).toString()).toBe('original-pixels');
    expect(after && (await readFile(after.filePath)).toString()).toBe('optimized-pixels');
    expect(await store.content(randomUUID(), 'before', 'full')).toBeNull();
  });

  it('serves a single original preview when an image was kept unchanged', async () => {
    const workspace = await temporaryWorkspace();
    const source = path.join(workspace, 'logo.svg');
    await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" />');
    const id = randomUUID();
    const store = new LandingPreviewStore();
    store.useWorkspace(workspace);

    expect(await store.cacheOriginal(id, source)).toBe(true);
    expect(store.metadata(id)).toEqual({ comparison: false, width: null, height: null });

    const before = await store.content(id, 'before', 'full');
    expect(before?.mimeType).toBe('image/svg+xml');
    expect(before && (await readFile(before.filePath)).toString()).toContain('<svg');
    expect(await store.content(id, 'after', 'full')).toBeNull();
  });

  it('refuses unsafe ids and removes cached content on demand', async () => {
    const workspace = await temporaryWorkspace();
    const source = path.join(workspace, 'hero.jpg');
    await writeFile(source, Buffer.from('original'));
    const store = new LandingPreviewStore();
    store.useWorkspace(workspace);

    expect(await store.cache('../outside', source, Buffer.from('after'), 10, 10)).toBe(false);
    const id = randomUUID();
    expect(await store.cache(id, source, Buffer.from('after'), 10, 10)).toBe(true);
    await store.remove(id);
    expect(store.metadata(id)).toBeNull();
    expect(await store.content(id, 'after', 'full')).toBeNull();
  });
});

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-preview-test-'));
  temporaryRoots.push(root);
  return root;
}
