import { mkdtemp } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  backoffMs,
  dueHandoffs,
  enqueueHandoff,
  readHandoff,
  recordResult
} from '../scripts/lib/release/handoff.mjs';
import {
  createProcessTransport,
  deliverPendingHandoffs,
  validateBridgeConfig
} from '../scripts/lib/release/agent-bridge.mjs';

const config = {
  protocolVersion: 1,
  executable: '/registered-bridge',
  allowedExecutables: ['/registered-bridge']
};

it('deduplicates durable handoff jobs without invoking a model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-handoff-'));
  try {
    const job = { jobId: 'one', fingerprint: 'same', runId: 'run' };
    expect((await enqueueHandoff(directory, job)).state).toBe('delivery_pending');
    // The same failure is the same job, whatever id the caller offers second.
    expect((await enqueueHandoff(directory, { ...job, jobId: 'two' })).jobId).toBe('one');
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

it('uses only a registered bridge and backs off a transport outage without losing the job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-bridge-'));
  try {
    const job = await enqueueHandoff(directory, {
      jobId: 'job-one',
      fingerprint: 'fingerprint',
      runId: 'run',
      payload: { code: 'GATE_FAILED' }
    });
    expect(
      validateBridgeConfig({
        protocolVersion: 1,
        executable: '/unregistered',
        allowedExecutables: []
      })
    ).toMatchObject({ ok: false, code: 'AGENT_BRIDGE_UNREGISTERED' });

    const seen: string[] = [];
    let attempts = 0;
    const transport = {
      call: async (request: { operation: string; jobId: string; fingerprint: string }) => {
        seen.push(request.operation);
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return {
          jobId: request.jobId,
          fingerprint: request.fingerprint,
          state: 'acknowledged',
          resultRef: 'bridge://job-one'
        };
      }
    };

    const start = Date.now();
    expect(
      await deliverPendingHandoffs({ directory, config, transport, now: start })
    ).toMatchObject({ ok: true, delivered: [], pending: ['job-one'] });
    // Still owned, still pending, and not retried until its backoff elapses.
    expect(await readHandoff(directory, job.fingerprint)).toMatchObject({
      state: 'delivery_pending',
      lastError: 'BRIDGE_UNAVAILABLE'
    });
    expect(await dueHandoffs(directory, start + 1_000)).toHaveLength(0);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(10)).toBe(5 * 60_000);

    const later = start + backoffMs(1);
    expect(
      await deliverPendingHandoffs({ directory, config, transport, now: later })
    ).toMatchObject({ ok: true, delivered: ['job-one'] });
    // The first attempt was already recorded as sent, so the retry asks about
    // that job rather than submitting a second one.
    expect(seen).toEqual(['submit', 'query']);
    expect(attempts).toBe(2);
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

it('queries an already-submitted job after a restart instead of starting a second repair', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-bridge-restart-'));
  try {
    await enqueueHandoff(directory, {
      jobId: 'job-two',
      fingerprint: 'restarted',
      runId: 'run',
      payload: { code: 'GATE_FAILED' }
    });
    const operations: string[] = [];
    const transport = {
      call: async (request: { operation: string; jobId: string; fingerprint: string }) => {
        operations.push(request.operation);
        // The bridge accepted the submission, then the connection died before
        // its reply arrived: the worst case this protocol has to survive.
        if (request.operation === 'submit') throw new Error('connection lost after accept');
        return {
          jobId: request.jobId,
          fingerprint: request.fingerprint,
          state: 'completed',
          result: { status: 'repaired', repairReference: 'pr/42' }
        };
      }
    };
    const start = Date.now();
    await deliverPendingHandoffs({ directory, config, transport, now: start });

    // The job is on record as submitted even though no reply came back, so the
    // retry asks about it rather than asking for a second repair.
    const pending = await readHandoff(directory, 'restarted');
    expect(pending).toMatchObject({ submitted: true, state: 'delivery_pending' });
    await deliverPendingHandoffs({
      directory,
      config,
      transport,
      now: start + backoffMs(pending.attempts)
    });
    expect(operations).toEqual(['submit', 'query']);

    const record = await readHandoff(directory, 'restarted');
    expect(record).toMatchObject({
      state: 'completed',
      result: { status: 'repaired', repairReference: 'pr/42' },
      // A repaired source is not a passed gate. The worker must rerun them.
      revalidationRequired: true
    });
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

it('keeps a decision the bridge could not make visible instead of claiming completion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-bridge-decision-'));
  try {
    await enqueueHandoff(directory, { jobId: 'job-three', fingerprint: 'undecided', runId: 'run' });
    const record = await recordResult(directory, 'undecided', {
      status: 'needsExternalDecision',
      repairReference: null
    });
    expect(record).toMatchObject({
      state: 'needs_external_decision',
      revalidationRequired: false
    });
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

it('runs the registered executable by fixed argv and never a string from an intent', async () => {
  const transport = createProcessTransport({ executable: process.execPath });
  // A bridge that answers nothing is unavailable, not a release failure.
  await expect(transport.call({ version: 1, operation: 'query' })).rejects.toThrow(
    'AGENT_BRIDGE_REPLY_INVALID'
  );
});
