import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { encodeWebp } from '../apps/agent/src/landing/webp.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('landing WebP optimization', () => {
  it('re-encodes an existing WebP instead of treating it as already optimized', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-webp-test-'));
    temporaryRoots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    const landing = path.join(root, 'site');
    await mkdir(landing, { recursive: true });

    const pixels = new Uint8ClampedArray(8 * 8 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels.set([126, 78, 210, 255], offset);
    }
    const original = await encodeWebp({ data: pixels, width: 8, height: 8 }, 'optimal');
    await writeFile(path.join(landing, 'hero.webp'), original);

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false });
    await optimizer.prepareFromFolderPath(landing);
    expect(await optimizer.start()).toBe(true);

    const job = optimizer.state().job;
    expect(job?.status).toBe('completed');
    expect(job?.assets[0]).toMatchObject({
      relPath: 'hero.webp',
      status: 'optimized',
      newRelPath: null,
      preview: { available: true, comparison: true, width: 8, height: 8 }
    });
    const output = job?.outputPath;
    expect(output).toBeTruthy();
    expect((await readFile(path.join(output!, 'hero.webp'))).byteLength).toBeGreaterThan(0);

    await optimizer.shutdown();
  });

  it('keeps the original WebP when re-encoding would make it larger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-webp-test-'));
    temporaryRoots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    const landing = path.join(root, 'site');
    await mkdir(landing, { recursive: true });

    const width = 64;
    const height = 64;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      pixels.set([(pixel * 17) % 256, (pixel * 29) % 256, (pixel * 43) % 256, 255], offset);
    }
    const original = await encodeWebp({ data: pixels, width, height }, 'optimal');
    await writeFile(path.join(landing, 'hero.webp'), original);

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false, imageQuality: 'high' });
    await optimizer.prepareFromFolderPath(landing);
    expect(await optimizer.start()).toBe(true);

    const job = optimizer.state().job;
    expect(job?.assets[0]).toMatchObject({
      relPath: 'hero.webp',
      status: 'skipped',
      optimizedSize: original.byteLength,
      note: 'no-gain',
      preview: { available: true, comparison: false, width, height }
    });
    const output = job?.outputPath;
    expect(output).toBeTruthy();
    expect(await readFile(path.join(output!, 'hero.webp'))).toEqual(original);

    await optimizer.shutdown();
  });
});
