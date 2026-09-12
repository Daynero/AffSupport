import { describe, expect, it } from 'vitest';
import { executeReleaseFlow } from '../scripts/lib/release/flow.mjs';
import {
  BACKEND_STEPS,
  BACKEND_STEP_IDS,
  STEP_IDS,
  heavySteps,
  stepDefinition
} from '../scripts/lib/release/steps.mjs';

describe('release runner ordered sandbox flow', () => {
  it('runs every phase in order, including Windows smoke before publishing', async () => {
    const effects: string[] = [];
    const result = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      backendPlan: { changes: [{ id: 'one' }] },
      adapter: {
        execute: async (stepId: string) => {
          effects.push(stepId);
          return { ok: true };
        }
      }
    });
    expect(result.ok).toBe(true);
    expect(effects).toEqual(STEP_IDS);
    expect(effects.indexOf('windows_smoke')).toBeLessThan(effects.indexOf('publish'));
    expect(effects.filter(step => step === 'beta_verify')).toHaveLength(1);
    expect(effects.indexOf('manifest_beta_verify')).toBeGreaterThan(effects.indexOf('manifest'));
    expect(effects.indexOf('live_verify')).toBeGreaterThan(effects.indexOf('deploy'));
  });

  it('admits every heavy boundary and never asks the machine about a light one', async () => {
    const admitted: string[] = [];
    const ran: string[] = [];
    const result = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      backendPlan: { changes: [{ id: 'one' }] },
      admission: {
        withAdmission: async (stepId: string, run: () => Promise<unknown>) => {
          admitted.push(stepId);
          return run();
        }
      },
      adapter: {
        execute: async (stepId: string) => {
          ran.push(stepId);
          return { ok: true };
        }
      }
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(STEP_IDS);
    expect(admitted).toEqual(heavySteps());
    // Build, dependency, archive, stack and hash boundaries are all guarded.
    // The two that run unadmitted cost this machine nothing: preflight reads,
    // and backend_apply writes to a remote database.
    expect(STEP_IDS.filter(id => !stepDefinition(id).heavy)).toEqual([
      'preflight',
      'backend_apply'
    ]);
  });

  it('stops the release rather than running a heavy step that was refused admission', async () => {
    const ran: string[] = [];
    const result = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      admission: {
        withAdmission: async (stepId: string) => {
          throw new Error(`RELEASE_ADMISSION_DENIED: ${stepId}`);
        }
      },
      adapter: {
        execute: async (stepId: string) => {
          ran.push(stepId);
          return { ok: true };
        }
      }
    });
    expect(result).toMatchObject({ ok: false, failedStep: 'prepare' });
    expect(ran).toEqual(['preflight']);
  });

  it('never reaches a backend step when no plan declares one', async () => {
    const ran: string[] = [];
    const result = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      // No plan at all — not an empty apply, but no step to apply it in.
      adapter: {
        execute: async (stepId: string) => {
          ran.push(stepId);
          return { ok: true };
        }
      }
    });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(STEP_IDS.filter(id => !BACKEND_STEP_IDS.includes(id)));
    for (const stepId of BACKEND_STEP_IDS) expect(ran).not.toContain(stepId);
  });

  it('rehearses declared backend changes on beta before anything depends on them', () => {
    // The order is the guarantee: rehearsal precedes the readiness gate, and the
    // apply lands after the artifacts are published but before the web deploy.
    expect(STEP_IDS.indexOf('backend_beta')).toBeLessThan(STEP_IDS.indexOf('readiness'));
    expect(STEP_IDS.indexOf('backend_apply')).toBeGreaterThan(STEP_IDS.indexOf('publish'));
    expect(STEP_IDS.indexOf('backend_apply')).toBeLessThan(STEP_IDS.indexOf('deploy'));
    expect(BACKEND_STEPS).toEqual({
      'before-readiness': 'backend_beta',
      'before-web': 'backend_apply'
    });
    // A remote write is reconciled, never killed and retried blindly.
    expect(stepDefinition('backend_apply')).toMatchObject({
      interruption: 'reconcile',
      retry: 'inspect-before-retry'
    });
  });

  it('reports the reason admission actually gave, not a generic resource wait', async () => {
    const result = await executeReleaseFlow({
      run: { targetKind: 'sandbox' },
      admission: {
        withAdmission: async () => {
          throw new Error('RELEASE_ADMISSION_DENIED: LEASE_CAPABILITY_INVALID');
        }
      },
      adapter: { execute: async () => ({ ok: true }) }
    });
    expect(result.error).toMatchObject({ code: 'RELEASE_ADMISSION_DENIED' });
  });
});
