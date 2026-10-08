import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  enqueueHandoff,
  recordAttempt,
  dueHandoffs,
  recordResult
} from '../scripts/lib/release/handoff.mjs';
describe('controller and legacy bridge ownership', () => {
  it('never delivers controller-owned failures through the legacy bridge', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'controller-outbox-'));
    await enqueueHandoff(
      directory,
      { fingerprint: 'controller', jobId: 'controller-job', owner: 'controller' },
      0
    );
    const legacy = await enqueueHandoff(
      directory,
      { fingerprint: 'legacy', jobId: 'legacy-job' },
      0
    );
    await recordAttempt(directory, legacy, { state: 'acknowledged' }, 0);
    expect((await dueHandoffs(directory, 30000)).map(job => job.jobId)).toEqual(['legacy-job']);
  });
  it('normalizes old terminal spellings but rejects unknown claims', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'controller-status-'));
    await enqueueHandoff(directory, { fingerprint: 'failure', jobId: 'job' }, 0);
    expect((await recordResult(directory, 'failure', { status: 'refused' })).result.status).toBe(
      'cannotRepair'
    );
    expect((await recordResult(directory, 'failure', { status: 'needs_owner' })).state).toBe(
      'needs_external_decision'
    );
    await expect(
      recordResult(directory, 'failure', { status: 'passed-everything' })
    ).rejects.toThrow('BRIDGE_RESULT_INVALID');
  });
});
