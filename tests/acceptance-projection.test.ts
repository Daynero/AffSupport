import { describe, expect, it } from 'vitest';
import { projectResource } from '../scripts/acceptance/projection.mjs';
describe('capacity projection semantics', () => {
  it('compares three billing cycles separately and charges onboarding once', () => {
    expect(
      projectResource({
        kind: 'monthly',
        activePerHour: 1,
        idlePerHour: 0.1,
        activeHoursPerDay: 8,
        onboarding: 20,
        otherPerMonth: 10,
        quota: 1000
      })
    ).toMatchObject({
      cycles: [318, 298, 298],
      total90: 914,
      maximumCycle: 318,
      withinBudget: true
    });
  });
  it('keeps physical allocated baseline and backlog in stock forecasts', () => {
    expect(
      projectResource({
        kind: 'stock',
        baseline: 100,
        growthPerDay: 2,
        backlog: 10,
        overhead: 10,
        quota: 1000
      })
    ).toMatchObject({ day30: 180, day90: 300, withinBudget: true });
  });
  it('never converts a missing gauge into zero or a pass', () => {
    expect(
      projectResource({
        kind: 'monthly',
        activePerHour: null,
        idlePerHour: 1,
        activeHoursPerDay: 8,
        onboarding: 0,
        otherPerMonth: 0,
        quota: 1000
      })
    ).toMatchObject({ withinBudget: null, reason: 'missing_measurement' });
  });
  it('requires thirty percent headroom', () => {
    expect(
      projectResource({
        kind: 'stock',
        baseline: 701,
        growthPerDay: 0,
        backlog: 0,
        overhead: 0,
        quota: 1000
      })
    ).toMatchObject({ withinBudget: false });
  });
  it('rejects negative growth used as invented physical disk reclamation', () => {
    expect(() =>
      projectResource({
        kind: 'stock',
        baseline: 100,
        growthPerDay: -1,
        backlog: 0,
        overhead: 0,
        quota: 1000
      })
    ).toThrow('ACCEPTANCE_PROJECTION_INVALID');
  });
});
