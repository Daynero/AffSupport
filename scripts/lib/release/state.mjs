import { STEP_IDS, dependenciesSatisfied } from './steps.mjs';

const TERMINAL = new Set(['cancelled', 'completed']);
const TRANSITIONS = Object.freeze({
  draft: new Set(['preflight', 'blocked', 'cancelled']),
  preflight: new Set(['queued', 'blocked', 'cancelled']),
  queued: new Set(['running', 'waiting_resource', 'blocked', 'cancelling']),
  running: new Set(['waiting_resource', 'waiting_remote', 'reconciling', 'blocked', 'cancelling', 'completed']),
  waiting_resource: new Set(['queued', 'running', 'blocked', 'cancelling']),
  waiting_remote: new Set(['running', 'reconciling', 'blocked', 'cancelling']),
  reconciling: new Set(['running', 'blocked', 'cancelling', 'completed']),
  blocked: new Set(['queued', 'reconciling', 'cancelled']),
  cancelling: new Set(['cancelled', 'reconciling', 'blocked']),
  cancelled: new Set(),
  completed: new Set()
});

export function initialRun(intent, now = new Date().toISOString()) {
  // The frozen identity travels in the snapshot, not in the worker's argv or
  // environment: the version and target a run was accepted for are the same
  // ones it finishes with, including after a resume by a different process.
  return Object.freeze({
    runId: intent.runId,
    sourceSha: intent.sourceSha,
    version: intent.version ?? null,
    bump: intent.bump ?? null,
    targetId: intent.targetId,
    targetKind: intent.targetKind,
    state: 'draft',
    currentStep: null,
    completedSteps: [],
    generation: 1,
    publicationState: 'none',
    updatedAt: now
  });
}

export function transition(run, next, now = new Date().toISOString()) {
  if (!TRANSITIONS[run.state]?.has(next)) throw new Error(`Invalid release transition: ${run.state} -> ${next}`);
  return Object.freeze({ ...run, state: next, updatedAt: now });
}

export function startStep(run, stepId, now = new Date().toISOString()) {
  if (!STEP_IDS.includes(stepId)) throw new Error(`Unknown release step: ${stepId}`);
  if (TERMINAL.has(run.state)) throw new Error(`Cannot start ${stepId} from terminal state ${run.state}`);
  if (!dependenciesSatisfied(stepId, new Set(run.completedSteps))) throw new Error(`Dependencies not satisfied for ${stepId}`);
  return Object.freeze({ ...run, state: 'running', currentStep: stepId, updatedAt: now });
}

export function completeStep(run, stepId, now = new Date().toISOString()) {
  if (run.state !== 'running' || run.currentStep !== stepId) throw new Error(`Cannot complete inactive step ${stepId}`);
  const completedSteps = [...new Set([...run.completedSteps, stepId])];
  const state = completedSteps.length === STEP_IDS.length ? 'completed' : 'queued';
  return Object.freeze({ ...run, state, currentStep: null, completedSteps, updatedAt: now });
}

export function cancelRun(run, now = new Date().toISOString()) {
  if (TERMINAL.has(run.state)) return run;
  return Object.freeze({ ...run, state: 'cancelled', currentStep: null, updatedAt: now });
}

export function resumeRun(run, now = new Date().toISOString()) {
  if (!['blocked', 'cancelled'].includes(run.state)) throw new Error(`Cannot resume ${run.state}`);
  return Object.freeze({ ...run, state: 'reconciling', generation: run.generation + 1, updatedAt: now });
}
