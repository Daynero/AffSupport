import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  completeJob,
  handleRequest,
  listJobs,
  readJob,
  submitJob
} from '../scripts/lib/release/bridge-inbox.mjs';
import { validateBridgeConfig } from '../scripts/lib/release/agent-bridge.mjs';

/**
 * The other side of the wire the runner has always known how to speak and has
 * never had anyone to speak to.
 *
 * The cases that matter are the ones about asking twice. Delivery is
 * at-least-once by construction — the runner writes "submitted" before it sends
 * — so the bridge has to make a repeated submission harmless, and has to be
 * able to say "I have never seen this" without that being mistaken for "nothing
 * happened".
 */

async function inbox() {
  return mkdtemp(join(tmpdir(), 'release-bridge-'));
}

const job = {
  version: BRIDGE_PROTOCOL_VERSION,
  operation: 'submit',
  jobId: 'run-1:fp-1',
  fingerprint: 'fp-1',
  runId: 'run-1',
  payload: { subject: 'macos_package failed', step: 'macos_package' }
};

describe('the repair bridge inbox', () => {
  it('accepts a failure once, however many times it arrives', async () => {
    const directory = await inbox();
    try {
      const first = await handleRequest(directory, job);
      const second = await handleRequest(directory, job);
      expect(first).toMatchObject({ jobId: job.jobId, fingerprint: 'fp-1', state: 'acknowledged' });
      expect(second).toEqual(first);
      // One record, not two: a second submission must never start a second
      // repair of a failure somebody is already fixing.
      expect(await listJobs(directory)).toHaveLength(1);
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('answers a query about a job it has never seen with unknown', async () => {
    const directory = await inbox();
    try {
      // `unknown` is what tells the runner a resubmission is safe. An error
      // here would leave it stuck, and a false `acknowledged` would lose the
      // failure entirely.
      expect(
        await handleRequest(directory, { ...job, operation: 'query', jobId: 'never-seen' })
      ).toEqual({
        version: 1,
        jobId: 'never-seen',
        fingerprint: 'fp-1',
        state: 'unknown'
      });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('returns the answer a person wrote, through the same protocol', async () => {
    const directory = await inbox();
    try {
      await handleRequest(directory, job);
      await completeJob(directory, job.jobId, {
        status: 'repaired',
        notes: 'rebuilt the artifact'
      });
      const reply = await handleRequest(directory, { ...job, operation: 'query' });
      expect(reply.state).toBe('completed');
      expect(reply.result).toMatchObject({ status: 'repaired', notes: 'rebuilt the artifact' });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('refuses a verdict nobody defined', async () => {
    const directory = await inbox();
    try {
      await handleRequest(directory, job);
      await expect(completeJob(directory, job.jobId, { status: 'probably fine' })).rejects.toThrow(
        'BRIDGE_RESULT_STATUS_INVALID'
      );
      expect((await readJob(directory, job.jobId))?.state).toBe('acknowledged');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('records when the runner took delivery, without changing the verdict', async () => {
    const directory = await inbox();
    try {
      await handleRequest(directory, job);
      await completeJob(directory, job.jobId, { status: 'refused' });
      const reply = await handleRequest(directory, { ...job, operation: 'acknowledge' });
      expect(reply.state).toBe('completed');
      expect((await readJob(directory, job.jobId))?.resultTakenAt).toBeTruthy();
      expect((await readJob(directory, job.jobId))?.result.status).toBe('refused');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('refuses a protocol it does not speak, and an operation it does not have', async () => {
    const directory = await inbox();
    try {
      expect(await handleRequest(directory, { ...job, version: 2 })).toMatchObject({
        state: 'unknown',
        error: 'PROTOCOL_VERSION_MISMATCH'
      });
      expect(
        await handleRequest(directory, { ...job, operation: 'repair-it-yourself' })
      ).toMatchObject({
        state: 'unknown',
        error: 'OPERATION_UNSUPPORTED'
      });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('will not let a job id name a file outside its inbox', async () => {
    const directory = await inbox();
    try {
      // The id crosses a process boundary, so it names a file only after it has
      // been proven to be one path segment.
      const reply = await handleRequest(directory, { ...job, jobId: '../escape' });
      expect(reply).toMatchObject({ state: 'unknown', error: 'BRIDGE_JOB_ID_INVALID' });
      expect(await listJobs(directory)).toEqual([]);
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('keeps the record readable by its owner alone', async () => {
    const directory = await inbox();
    try {
      const stored = await submitJob(directory, job);
      expect(stored.state).toBe('acknowledged');
      // Diagnostics travel in these records; they are not world-readable.
      const contents = await readFile(join(directory, `${job.jobId}.json`), 'utf8');
      expect(JSON.parse(contents).payload.step).toBe('macos_package');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('registers an executable the runner is allowed to speak to', async () => {
    const directory = await inbox();
    try {
      const configPath = join(directory, 'bridge.json');
      const executable = join(directory, 'release-bridge.mjs');
      await writeFile(
        configPath,
        JSON.stringify({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          executable,
          allowedExecutables: [executable]
        })
      );
      expect(validateBridgeConfig(JSON.parse(await readFile(configPath, 'utf8')))).toMatchObject({
        ok: true
      });
      // A config naming a program that is not on its own allow-list is how a
      // release would end up talking to something nobody installed.
      expect(
        validateBridgeConfig({ protocolVersion: 1, executable, allowedExecutables: [] })
      ).toMatchObject({ ok: false, code: 'AGENT_BRIDGE_UNREGISTERED' });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });
});
