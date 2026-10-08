import { STEP_DEFINITIONS } from './steps.mjs';
import { readFileSync } from 'node:fs';
const profiles = JSON.parse(readFileSync(new URL('../../../config/release-resource-profiles.json', import.meta.url), 'utf8'));
export function freezeProgress(history = []) {
  return STEP_DEFINITIONS.map((step) => {
    const durations = history.filter((e) => e.type === 'step_completed' && e.payload?.stepId === step.id && e.payload.durationMs > 0)
      .slice(-10).map((e) => e.payload.durationMs / 1000).sort((a, b) => a - b);
    const measured = profiles.default.classes[step.resourceClass]?.measured?.durationSeconds;
    return { id: step.id, weight: durations.length ? durations[Math.floor(durations.length / 2)] : measured ?? 1,
      confidence: durations.length || measured ? 'measured' : 'low' };
  });
}
export function projectProgress(plan, run, events) {
  const complete = new Set(events.filter((e) => ['step_completed', 'step_not_declared'].includes(e.type)).map((e) => e.payload?.stepId));
  const excluded = new Set(events.filter((e) => e.type === 'step_not_declared').map((e) => e.payload?.stepId));
  const final = run.state === 'completed' && events.some((e) => e.type === 'run_completed') && complete.has('live_verify') && plan.every((s) => complete.has(s.id));
  const denominator = plan.reduce((n, s) => n + s.weight, 0);
  const numerator = plan.filter((s) => complete.has(s.id)).reduce((n, s) => n + s.weight, 0);
  return { percent: final ? 100 : Math.min(99, Math.floor(100 * numerator / denominator)), final,
    nativePercent: null, steps: plan.map((s) => ({ ...s, status: excluded.has(s.id) ? 'excluded' : complete.has(s.id) ? 'completed' : run.currentStep === s.id ? 'running' : 'pending' })) };
}
