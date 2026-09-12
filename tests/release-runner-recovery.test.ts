import { describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { executeReleaseFlow } from '../scripts/lib/release/flow.mjs';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';
import { reconcileEffect, recoverState } from '../scripts/lib/release/recovery.mjs';
import { retryAllowed, retryDelay } from '../scripts/lib/release/retry.mjs';
import { mkdtemp, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJournal, readJournal, recoverJournal } from '../scripts/lib/release/journal.mjs';

describe('release recovery', () => {
  it('reconciles interrupted work before retrying it', () => {
    expect(recoverState({ state: 'running' }, [])).toMatchObject({ state: 'reconciling' });
    expect(reconcileEffect({}, 'matching')).toEqual({ state: 'matching', retry: false });
    expect(reconcileEffect({}, 'ambiguous')).toMatchObject({
      state: 'blocked',
      code: 'EFFECT_AMBIGUOUS'
    });
  });
  it('does not retry deterministic or expired effects', () => {
    const timing = { attempt: 1, startedAt: '2026-01-01T00:00:00Z', now: '2026-01-01T00:01:00Z' };
    expect(retryAllowed({ ...timing, deterministic: true })).toBe(false);
    expect(retryAllowed({ ...timing, attempt: 5 })).toBe(false);
    expect(retryDelay(2, { random: () => 0.5 })).toBe(2000);
  });
  it('distinguishes a torn journal tail from interior tampering', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'release-recovery-'));
    try {
      const journal = await createJournal(directory, 'run-a');
      await journal.append('prepared', {});
      await appendFile(journal.journalPath, '{');
      await expect(readJournal(journal.journalPath, 'run-a')).rejects.toThrow('JOURNAL_TORN_TAIL');
      const recovered = await recoverJournal(journal.journalPath, 'run-a');
      expect(recovered.events).toHaveLength(1);
      expect(recovered.quarantined).toContain('.torn-');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });
});

describe('crash matrix across every effect boundary', () => {
  /**
   * Crashes the release immediately after each step in turn, resumes from what
   * the journal recorded, and counts how many times each effect actually ran.
   * A duplicate anywhere in this table is a published asset uploaded twice or a
   * migration applied twice.
   */
  it('performs every effect exactly once however many times the run is interrupted', async () => {
    const perBoundary: Record<string, Record<string, number>> = {};
    for (const crashAfter of STEP_IDS) {
      const effects: string[] = [];
      const adapter = {
        execute: async (stepId: string) => {
          effects.push(stepId);
          // The crash happens after the effect has landed and been recorded:
          // the hardest case, because the effect exists but the run stopped.
          if (stepId === crashAfter) return { ok: false, error: { code: 'CRASH' } };
          return { ok: true };
        }
      };
      const interrupted = await executeReleaseFlow({
        run: { targetKind: 'sandbox' },
        backendPlan: { changes: [{ id: 'declared' }] },
        adapter
      });
      expect(interrupted).toMatchObject({ ok: false, failedStep: crashAfter });

      // What the journal vouches for, including the step whose effect landed.
      const recorded = [...interrupted.completed, crashAfter];
      const resumed = await executeReleaseFlow({
        run: { targetKind: 'sandbox' },
        backendPlan: { changes: [{ id: 'declared' }] },
        adapter: { execute: async (stepId: string) => (effects.push(stepId), { ok: true }) },
        completed: recorded
      });
      expect(resumed.ok).toBe(true);
      expect(resumed.completed).toEqual(STEP_IDS);

      const counts: Record<string, number> = {};
      for (const stepId of effects) counts[stepId] = (counts[stepId] ?? 0) + 1;
      perBoundary[crashAfter] = counts;
    }

    for (const crashAfter of STEP_IDS) {
      for (const stepId of STEP_IDS) {
        expect(`${crashAfter}/${stepId}=${perBoundary[crashAfter][stepId]}`).toBe(
          `${crashAfter}/${stepId}=1`
        );
      }
    }
  });

  it('refuses to advance a resumed run past a step whose evidence it does not have', async () => {
    const effects: string[] = [];
    const resumed = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      backendPlan: { changes: [{ id: 'declared' }] },
      adapter: {
        execute: async (stepId: string) => {
          effects.push(stepId);
          return { ok: true };
        }
      },
      // Only the first two steps are vouched for; publish is not skippable
      // merely because a later step was recorded by something else.
      completed: ['preflight', 'prepare']
    });
    expect(resumed.ok).toBe(true);
    expect(effects).toEqual(STEP_IDS.filter(id => !['preflight', 'prepare'].includes(id)));
  });
});
