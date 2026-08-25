import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { zipDirectory } from '../apps/agent/src/platform/platform.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

async function landingFolder(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<html><body>hi</body></html>');
  await writeFile(
    path.join(dir, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
  );
  return dir;
}

describe('landing optimizer writes results next to the source', () => {
  it('optimizes a picked/recovered folder into <name>-optimized beside it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-loc-folder-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    const source = await landingFolder(root, 'promo');

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: false });
    await optimizer.prepareFromFolderPath(source);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const output = (optimizer.state().jobs[0] ?? optimizer.state().job!).outputPath!;

    expect(output).toBeTruthy();
    expect(path.dirname(output)).toBe(root); // beside the source folder, not in Downloads
    expect(path.basename(output)).toBe('promo-optimized');
    await expect(access(output)).resolves.toBeUndefined();
    await optimizer.shutdown();
  }, 60_000);

  it('optimizes a recovered dropped ZIP into an archive beside the original', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'landing-loc-zip-'));
    roots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    const source = await landingFolder(root, 'promo');
    const zipPath = path.join(root, 'promo.zip');
    await zipDirectory(source, zipPath);

    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {});
    optimizer.updateSettings({ archive: true });
    // This is the path the drag-drop route now takes once findDroppedSource
    // matches the uploaded archive back to its on-disk original.
    await optimizer.prepareFromZipPath(zipPath);
    const job = optimizer.state().jobs[0] ?? optimizer.state().job!;
    await optimizer.start([job.id]);
    const output = (optimizer.state().jobs[0] ?? optimizer.state().job!).outputPath!;

    expect(output).toBeTruthy();
    expect(path.dirname(output)).toBe(root); // beside promo.zip, not in Downloads
    expect(path.basename(output)).toBe('promo-optimized.zip');
    await expect(access(output)).resolves.toBeUndefined();
    await optimizer.shutdown();
  }, 60_000);
});
