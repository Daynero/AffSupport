import { spawnSync } from 'node:child_process';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorker, workerReady } from '../scripts/release-worker.mjs';
import { readJournal } from '../scripts/lib/release/journal.mjs';
import { loadSnapshot, saveSnapshot } from '../scripts/lib/release/store.mjs';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';

it('emits a durable-ready shaped acknowledgement without terminal state', () => {
  expect(workerReady('run')).toMatchObject({ runId: 'run', ready: true });
});

describe('the worker actually performs the release', () => {
  async function seed(state: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'release-worker-'));
    const runId = 'worker-run';
    const previous = process.env.SOTY_RELEASE_RUNNER_DIR;
    process.env.SOTY_RELEASE_RUNNER_DIR = root;
    await saveSnapshot({
      runId,
      sourceSha: 'a'.repeat(40),
      state: 'queued',
      currentStep: null,
      completedSteps: [],
      generation: 1,
      publicationState: 'none',
      targetKind: 'sandbox',
      updatedAt: new Date().toISOString(),
      ...state
    });
    return {
      root,
      runId,
      restore: () => {
        if (previous === undefined) delete process.env.SOTY_RELEASE_RUNNER_DIR;
        else process.env.SOTY_RELEASE_RUNNER_DIR = previous;
      }
    };
  }

  it('runs every step, journals each one before its effect, and records completion', async () => {
    const { root, runId, restore } = await seed();
    const ran: string[] = [];
    try {
      const result = await runWorker({
        runId,
        backendPlan: { changes: [{ id: 'declared' }] },
        adapter: {
          execute: async (stepId: string) => {
            ran.push(stepId);
            return { ok: true };
          }
        }
      });
      expect(result).toMatchObject({ ok: true });
      expect(ran).toEqual([...STEP_IDS]);

      const events = await readJournal(join(root, runId, 'journal.ndjson'), runId);
      const types = events.map(event => event.type);
      expect(types[0]).toBe('worker_started');
      expect(types.at(-1)).toBe('run_completed');
      // Started is written before the effect could have landed, completed after.
      for (const stepId of STEP_IDS) {
        const started = events.findIndex(
          event => event.type === 'step_started' && event.payload.stepId === stepId
        );
        const completed = events.findIndex(
          event => event.type === 'step_completed' && event.payload.stepId === stepId
        );
        expect(`${stepId}:${started < completed && started >= 0}`).toBe(`${stepId}:true`);
      }
      expect((await loadSnapshot(runId)).completedSteps).toEqual([...STEP_IDS]);
    } finally {
      restore();
      await removeTemporaryDirectory(root);
    }
  }, 30_000);

  it('turns a failure into one bounded, redacted handoff and blocks the run', async () => {
    const { root, runId, restore } = await seed();
    try {
      const result = await runWorker({
        runId,
        adapter: {
          execute: async (stepId: string) =>
            stepId === 'candidate_gate'
              ? {
                  ok: false,
                  error: { code: 'GATE_FAILED', subject: `token ghp_${'a'.repeat(40)}` }
                }
              : { ok: true }
        }
      });
      expect(result).toMatchObject({ ok: false, state: 'blocked', failedStep: 'candidate_gate' });

      const jobs = await readdir(join(root, runId, 'handoff'));
      expect(jobs).toHaveLength(1);
      const job = JSON.parse(await readFile(join(root, runId, 'handoff', jobs[0]), 'utf8'));
      expect(job).toMatchObject({ runId, state: 'delivery_pending', submitted: false });
      // The thing that leaves the machine carries no secret.
      expect(JSON.stringify(job)).not.toContain('ghp_');
      expect((await loadSnapshot(runId)).state).toBe('blocked');
    } finally {
      restore();
      await removeTemporaryDirectory(root);
    }
  }, 30_000);

  it('resumes where the journal left off instead of repeating landed effects', async () => {
    const { root, runId, restore } = await seed({
      state: 'queued',
      completedSteps: ['preflight', 'prepare', 'candidate_gate']
    });
    const ran: string[] = [];
    try {
      const result = await runWorker({
        runId,
        adapter: {
          execute: async (stepId: string) => {
            ran.push(stepId);
            return { ok: true };
          }
        }
      });
      expect(result.ok).toBe(true);
      for (const stepId of ['preflight', 'prepare', 'candidate_gate']) {
        expect(ran).not.toContain(stepId);
      }
    } finally {
      restore();
      await removeTemporaryDirectory(root);
    }
  }, 30_000);

  it('refuses to act on a run whose frozen identity it cannot resolve', async () => {
    // The snapshot carries no version, so there is no release this worker could
    // legitimately perform. Exiting zero here would look like a finished run.
    const { root, runId, restore } = await seed({ version: null });
    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/release-worker.mjs', '--ready-file', join(root, 'ready.json'), runId],
        {
          cwd: process.cwd(),
          env: { ...process.env, SOTY_RELEASE_RUNNER_DIR: root, SOTY_RELEASE_DRY_RUN: '1' },
          encoding: 'utf8'
        }
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('STEP_ADAPTER_IDENTITY_INVALID');
      // It still acknowledged durably: the runner's contract is unaffected.
      expect(JSON.parse(await readFile(join(root, 'ready.json'), 'utf8'))).toMatchObject({
        runId,
        ready: true
      });
    } finally {
      restore();
      await removeTemporaryDirectory(root);
    }
  }, 30_000);
});
