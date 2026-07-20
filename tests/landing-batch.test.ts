import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LandingState } from '../packages/shared/src/types.js';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('landing optimizer batch queue', () => {
  it('keeps multiple landings and processes them through one sequential queue', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-landing-batch-'));
    temporaryRoots.push(root);
    vi.stubEnv('AGENT_LANDING_WORKSPACE', path.join(root, 'workspaces'));
    const first = await landingFixture(root, 'first');
    const second = await landingFixture(root, 'second');
    const snapshots: LandingState[] = [];
    const optimizer = new LandingOptimizer({ ffmpeg: true, ffprobe: true }, () => {
      snapshots.push(optimizer.state());
    });
    optimizer.updateSettings({ archive: false });

    await optimizer.prepareFromFolderPath(first);
    await optimizer.prepareFromFolderPath(second);
    const ready = optimizer.state();
    expect(ready.jobs).toHaveLength(2);
    expect(ready.jobs.map(job => job.name)).toEqual(['first', 'second']);
    expect(ready.jobs.every(job => job.status === 'ready')).toBe(true);

    expect(await optimizer.start(ready.jobs.map(job => job.id))).toBe(true);
    const completed = optimizer.state();
    expect(completed.running).toBe(false);
    expect(completed.jobs.every(job => job.status === 'completed')).toBe(true);
    expect(snapshots.some(state => state.jobs.some(job => job.status === 'queued'))).toBe(true);
    expect(
      snapshots.every(state => state.jobs.filter(job => job.status === 'processing').length <= 1)
    ).toBe(true);
    for (const job of completed.jobs) {
      expect(job.outputPath).toBeTruthy();
      await expect(access(job.outputPath!)).resolves.toBeUndefined();
    }

    expect(await optimizer.remove(completed.jobs[0].id)).toBe(true);
    expect(optimizer.state().jobs.map(job => job.name)).toEqual(['second']);
    await optimizer.clearFinished();
    expect(optimizer.state().jobs).toEqual([]);
    await optimizer.shutdown();
  });
});

async function landingFixture(root: string, name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
  );
  return directory;
}
