import { expect, it } from 'vitest';
import { cancelRun, resumeRun } from '../scripts/lib/release/state.mjs';

it('persists cancellation without deleting or rolling back effects', () => {
  const cancelled = cancelRun({ state: 'running', currentStep: 'publish', generation: 1 });
  expect(cancelled).toMatchObject({ state: 'cancelled', currentStep: null });
  expect(resumeRun(cancelled)).toMatchObject({ state: 'reconciling', generation: 2 });
});
