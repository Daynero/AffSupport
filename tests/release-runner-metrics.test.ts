import { expect, it } from 'vitest';
import { releaseMetrics } from '../scripts/lib/release/metrics.mjs';

it('keeps handoffs separate from actual model token accounting', () => {
  expect(
    releaseMetrics([{ type: 'handoff_accepted' }, { type: 'effect_observed', kind: 'publish' }])
  ).toEqual({ timings: {}, effects: { publish: 1 }, handoffs: 1, modelTokens: null });
});
