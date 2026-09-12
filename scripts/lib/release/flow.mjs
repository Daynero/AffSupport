import { BACKEND_STEP_IDS, STEP_IDS, stepDefinition } from './steps.mjs';

/**
 * Walks the registry in order, admitting each heavy step before it runs.
 *
 * The admission wrapper lives here rather than inside each adapter so that the
 * list of guarded boundaries is exactly the registry's `heavy` set: adding a
 * step that compiles or hashes cannot accidentally skip the machine check,
 * because the flow consults the definition, not the adapter's opinion.
 *
 * A release with no declared backend plan does not merely apply zero changes —
 * it does not run the backend steps at all, so there is no code path on which a
 * server write could happen by accident.
 *
 * `completed` is what a resumed run already did. Replaying those steps would
 * mean uploading an asset twice or applying a migration twice, so a resume
 * starts at the first step the journal does not vouch for — the flow never
 * re-derives that list, it is told.
 *
 * @param {{
 *   run: unknown,
 *   adapter: {execute: (stepId: string, run: unknown) => Promise<{ok: boolean, error?: unknown}>},
 *   admission?: {withAdmission: (stepId: string, run: () => Promise<any>) => Promise<any>} | null,
 *   backendPlan?: {changes: readonly unknown[]} | null,
 *   completed?: readonly string[],
 *   onStep?: (event: {stepId: string, phase: string}) => void | Promise<void>
 * }} options
 */
export async function executeReleaseFlow({
  run,
  adapter,
  admission = null,
  backendPlan = null,
  completed: alreadyCompleted = [],
  onStep = () => {}
}) {
  const completed = [...alreadyCompleted];
  const backendDeclared = Boolean(backendPlan?.changes?.length);
  for (const stepId of STEP_IDS) {
    if (completed.includes(stepId)) {
      await onStep({ stepId, phase: 'skipped' });
      continue;
    }
    if (!backendDeclared && BACKEND_STEP_IDS.includes(stepId)) {
      // Nothing declared it, so there is nothing to do — and a step with
      // nothing to do is complete, not pending. Recording it keeps the
      // dependency chain intact for the steps that follow, while the adapter is
      // never called, so no server write can happen by accident.
      completed.push(stepId);
      await onStep({ stepId, phase: 'not_declared' });
      continue;
    }
    const step = stepDefinition(stepId);
    await onStep({ stepId, phase: 'started' });
    const execute = () => adapter.execute(stepId, run);
    let result;
    try {
      result =
        step.heavy && admission
          ? await admission.withAdmission(stepId, execute)
          : await execute();
    } catch (error) {
      // Keep the reason the admission authority actually gave. Reporting a
      // refused capability or a stale generation as "waiting for resources"
      // would send the operator to look at memory graphs for a problem that is
      // really a broken lease.
      const subject = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        completed,
        failedStep: stepId,
        error: { code: /^[A-Z_]+(?=:)/u.exec(subject)?.[0] ?? 'RESOURCE_WAIT', subject }
      };
    }
    if (!result?.ok)
      return {
        ok: false,
        completed,
        failedStep: stepId,
        error: result?.error ?? { code: 'GATE_FAILED' }
      };
    completed.push(stepId);
    await onStep({ stepId, phase: 'completed' });
  }
  return { ok: true, completed };
}
