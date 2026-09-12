import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reusableEvidence } from '../scripts/lib/release/evidence.mjs';
import { invalidatedSteps } from '../scripts/lib/release/evidence.mjs';
import { createJournal, readJournal } from '../scripts/lib/release/journal.mjs';
import { ownsLiveProcess } from '../scripts/lib/release/ownership.mjs';

describe('release runner durable foundation', () => {
  it('writes a fsynced hash-chain journal and an atomic private snapshot', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'release-journal-'));
    try {
      const journal = await createJournal(directory, 'run-1');
      await journal.append('effect_prepared', { effectId: 'one' });
      await journal.snapshot({ state: 'running' });
      expect(await readJournal(journal.journalPath, 'run-1')).toHaveLength(1);
      expect(JSON.parse(await readFile(journal.snapshotPath, 'utf8')).state).toEqual({
        state: 'running'
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('rejects a reused PID and keeps published artifacts immutable', () => {
    expect(
      ownsLiveProcess(
        { pid: 10, startedAt: 1, bootId: 'a' },
        { isAlive: () => true, startedAt: () => 2, bootId: () => 'a' }
      )
    ).toBe(false);
    expect(reusableEvidence({ sourceSha: 'a' }, { sourceSha: 'b' }, { published: true })).toEqual({
      reusable: true,
      action: 'preserve_published_output'
    });
  });
  it('invalidates only unpublished dependent work when inputs change', () => {
    expect([
      ...invalidatedSteps(
        { sourceSha: 'a' },
        { sourceSha: 'b' },
        { package: ['sourceSha'], publish: ['artifactDigest'] }
      )
    ]).toEqual(['package']);
  });
});
