import { expect, it } from 'vitest';
import { resourceCounterDelta } from '../scripts/acceptance/resource-counters.mjs';
import { resourceCounterCases } from './fixtures/resource-counter-cases.mjs';

for (const [name, before, after, elapsedMs, expected] of resourceCounterCases) {
  it(`keeps resource counter evidence honest: ${name}`, () => {
    expect(resourceCounterDelta(before, after, elapsedMs)).toEqual(expected);
  });
}
