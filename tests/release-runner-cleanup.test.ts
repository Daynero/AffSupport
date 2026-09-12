import { mkdir, writeFile, utimes, access } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupRuns } from '../scripts/lib/release/cleanup.mjs';

describe('release cleanup', () => {
  it('removes only aged completed owned runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'release-cleanup-'));
    const old = path.join(root, 'old');
    const active = path.join(root, 'active');
    await mkdir(old);
    await mkdir(active);
    await writeFile(path.join(old, 'snapshot.json'), JSON.stringify({ state: 'completed' }));
    await writeFile(path.join(active, 'snapshot.json'), JSON.stringify({ state: 'running' }));
    await utimes(old, 0, 0);
    expect(await cleanupRuns(root, { now: 31 * 24 * 60 * 60 * 1000 })).toEqual(['old']);
    await expect(access(active)).resolves.toBeUndefined();
  });
});
