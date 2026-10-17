import { expect, it } from 'vitest';
import {
  launchBudgets,
  launchPreview,
  launchNamingPreview,
  parseLaunchConfig,
  parseLaunchDraft
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
it('spans both limits, rounds intermediate budgets, and uses the maximum for one campaign', () => {
  expect(launchBudgets(3, 60, null, 20)).toEqual([20, 40, 60]);
  expect(launchBudgets(4, 30, null, 10)).toEqual([10, 17, 23, 30]);
  expect(launchBudgets(1, 60, null, 20)).toEqual([60]);
  expect(launchBudgets(1, 20, null, 20)).toEqual([20]);
  expect(launchBudgets(3, 30)).toEqual([10, 20, 30]);
  expect(launchBudgets(4, 30)).toEqual([8, 15, 23, 30]);
});
it('rejects invalid, reversed, or too narrow bounds and manual amounts below the minimum', () => {
  for (const min of [0, -1, 1.5, NaN, Infinity, 31])
    expect(() => launchBudgets(3, 30, null, min)).toThrow('LAUNCH_BUDGET_INVALID');
  expect(() => launchBudgets(4, 12, null, 10)).toThrow('LAUNCH_BUDGET_INVALID');
  expect(() => launchBudgets(3, 30, [8, 20, 30], 10)).toThrow('LAUNCH_BUDGET_INVALID');
});
it('round trips minimum budgets and uses the same amounts in naming and authoritative previews', () => {
  const config = launchConfig({ campaignCount: 4, minBudget: 10, maxBudget: 30 });
  expect(parseLaunchDraft(config)?.minBudget).toBe(10);
  const parsed = parseLaunchConfig(config);
  expect(parsed).toMatchObject({ ok: true, value: { minBudget: 10 } });
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  expect(preview.value.campaigns.map(row => row.budget)).toEqual([10, 17, 23, 30]);
  expect(launchNamingPreview(config, launchSources).map(row => row.budget)).toEqual([
    10, 17, 23, 30
  ]);
  expect(parseLaunchConfig({ ...config, minBudget: 40 })).toMatchObject({
    ok: false,
    errors: { minBudget: 'LAUNCH_BUDGET_INVALID' }
  });
  expect(parseLaunchConfig({ ...config, minBudget: 29 })).toMatchObject({
    ok: false,
    errors: { budgets: 'LAUNCH_BUDGET_INVALID' }
  });
});
