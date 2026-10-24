/** A projection describes the measurements supplied; it never invents unavailable gauges. */
export function projectResource(input) {
  if (!input || typeof input !== 'object' || !['monthly', 'stock'].includes(input.kind))
    throw new Error('ACCEPTANCE_PROJECTION_INVALID');
  const fields =
    input.kind === 'monthly'
      ? [
          'activePerHour',
          'idlePerHour',
          'activeHoursPerDay',
          'onboarding',
          'otherPerMonth',
          'quota'
        ]
      : ['baseline', 'growthPerDay', 'backlog', 'overhead', 'quota'];
  if (fields.some(key => input[key] === null || input[key] === undefined))
    return { withinBudget: null, reason: 'missing_measurement' };
  if (
    fields.some(
      key => typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0
    ) ||
    input.quota <= 0 ||
    (input.kind === 'monthly' && input.activeHoursPerDay > 24)
  )
    throw new Error('ACCEPTANCE_PROJECTION_INVALID');
  if (input.kind === 'monthly') {
    const recurring =
      30 *
        (input.activeHoursPerDay * input.activePerHour +
          (24 - input.activeHoursPerDay) * input.idlePerHour) +
      input.otherPerMonth;
    const cycles = [recurring + input.onboarding, recurring, recurring];
    const maximumCycle = Math.max(...cycles);
    return {
      kind: 'monthly',
      cycles,
      total90: cycles.reduce((sum, value) => sum + value, 0),
      maximumCycle,
      headroom: 1 - maximumCycle / input.quota,
      withinBudget: maximumCycle <= input.quota * 0.7
    };
  }
  const day30 = input.baseline + input.growthPerDay * 30 + input.backlog + input.overhead;
  const day90 = input.baseline + input.growthPerDay * 90 + input.backlog + input.overhead;
  return {
    kind: 'stock',
    day30,
    day90,
    headroom: 1 - day90 / input.quota,
    withinBudget: day90 <= input.quota * 0.7,
    physicalReclamationAssumed: false
  };
}
