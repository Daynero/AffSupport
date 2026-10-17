import { describe, expect, it } from 'vitest';
import {
  launchBudgets,
  launchPreview,
  launchTomorrow,
  parseLaunchConfig
} from '../packages/shared/src/team/launches.js';
import { launchConfig, launchSources } from './fixtures/launches.js';
describe('Launch pure domain', () => {
  it('uses Math.round rather than total-budget allocation', () => {
    expect(launchBudgets(4, 30)).toEqual([8, 15, 23, 30]);
    expect(launchBudgets(5, 70)).toEqual([14, 28, 42, 56, 70]);
    expect(() => launchBudgets(5, 3)).toThrow();
    expect(() => launchBudgets(3, 30, [10, 10, 30])).toThrow();
  });
  it('generates all campaign names and one advertising URL', () => {
    const p = launchPreview(launchConfig({ method: 'catalog' }), launchSources);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error('preview fixture invalid');
    expect(p.value.campaigns.map(c => c.name)).toEqual([
      '[g1-892-v5-c] ProCaps TR $10 m45+ 13/10 #1(1-3)',
      '[g1-892-v5-c] ProCaps TR $20 m45+ 13/10 #2(4-6)',
      '[g1-892-v5-c] ProCaps TR $30 m45+ 13/10 #3(7-9)'
    ]);
    expect(p.value.advertisingUrl).toBe('https://example.invalid/?pixel=token&x={{campaign.id}}');
  });
  it('changes names only for demographic fields and does not mutate inputs', () => {
    const config = launchConfig();
    const snapshot = JSON.stringify(config);
    const a = launchPreview(config, launchSources);
    const b = launchPreview(
      { ...config, age: 100, gender: 'ALL', advantagePlus: true },
      launchSources
    );
    expect(a.ok && b.ok && a.value.advertisingUrl === b.value.advertisingUrl).toBe(true);
    expect(JSON.stringify(config)).toBe(snapshot);
    if (b.ok) expect(b.value.campaigns[0].name).toContain('all100+ adv+');
  });
  it('validates all relevant sources and config', () => {
    expect(parseLaunchConfig(launchConfig()).ok).toBe(true);
    expect(parseLaunchConfig(launchConfig({ age: 0 })).ok).toBe(false);
    expect(
      parseLaunchConfig(
        launchConfig({
          subConfig: { schemaVersion: 1, sub1: ['buyer', 'buyer'], sub2: [], sub3: [] }
        })
      ).ok
    ).toBe(false);
    expect(launchPreview(launchConfig({ creativeAlias: 'Відео' }), launchSources).ok).toBe(false);
    expect(launchPreview(launchConfig(), { ...launchSources, agentId: 'not-numeric' }).ok).toBe(
      false
    );
  });
  it('computes next calendar day in a supplied timezone around DST and year end', () => {
    expect(launchTomorrow(new Date('2026-12-31T23:30:00Z'), 'Europe/Kyiv')).toBe('2027-01-02');
    expect(launchTomorrow(new Date('2026-03-28T23:30:00Z'), 'Europe/Kyiv')).toBe('2026-03-30');
    expect(launchTomorrow(new Date('2028-02-28T12:00:00Z'), 'UTC')).toBe('2028-02-29');
  });
});

it('covers every specified budget example and accepts valid manual corrections', () => {
  for (const [count, expected] of [
    [1, [30]],
    [2, [15, 30]],
    [3, [10, 20, 30]],
    [4, [8, 15, 23, 30]],
    [5, [6, 12, 18, 24, 30]]
  ] as const)
    expect(launchBudgets(count, 30)).toEqual(expected);
  expect(launchBudgets(3, 30, [8, 19, 30])).toEqual([8, 19, 30]);
  for (const values of [
    [8, 19, 29],
    [0, 19, 30],
    [8, 31, 30],
    [8, 8, 30],
    [8, 19.5, 30]
  ])
    expect(() => launchBudgets(3, 30, values)).toThrow();
});
it('reuses restitch bounds and ignores inactive catalog limits for Other', () => {
  const custom = {
    productCount: 100,
    restitchEnabled: true,
    finalDurationMode: 'custom' as const,
    customFinalDurationSeconds: 3660
  };
  expect(parseLaunchConfig(launchConfig({ method: 'catalog', catalog: custom })).ok).toBe(false);
  expect(
    parseLaunchConfig(
      launchConfig({ method: 'catalog', catalog: { ...custom, customFinalDurationSeconds: 3600 } })
    ).ok
  ).toBe(true);
  expect(parseLaunchConfig(launchConfig({ method: 'other', catalog: custom })).ok).toBe(true);
});
it('computes a 100-campaign preview in less than 50ms without mutating inputs', () => {
  const config = launchConfig({ campaignCount: 100, maxBudget: 1000 });
  const before = JSON.stringify({ config, launchSources });
  const start = performance.now();
  const result = launchPreview(config, launchSources);
  const elapsed = performance.now() - start;
  expect(result.ok).toBe(true);
  expect(elapsed).toBeLessThan(50);
  expect(JSON.stringify({ config, launchSources })).toBe(before);
});

it('previews names and SUB from just their local dependencies while authoritative generation still rejects incomplete configuration', async () => {
  const { launchNamingPreview, launchSubPreview } =
    await import('../packages/shared/src/team/launches');
  const complete = launchConfig();
  const draft = { ...complete, originalUrl: '', materialId: undefined };
  const names = launchNamingPreview(draft, launchSources);
  expect(names.map(row => row.name)).toEqual(
    launchNamingPreview(complete, launchSources).map(row => row.name)
  );
  expect(parseLaunchConfig(draft).ok).toBe(false);
  expect(launchSubPreview(complete.subConfig, undefined, { buyer: 'new buyer' })).toEqual({
    sub1: 'new_buyer',
    sub2: null,
    sub3: null
  });
  expect(
    launchSubPreview({ schemaVersion: 1, sub1: [], sub2: ['creative'], sub3: [] }, 'video one', {})
  ).toEqual({
    sub1: null,
    sub2: 'video_one',
    sub3: null
  });
  expect(
    launchNamingPreview({ ...draft, age: undefined }, launchSources).map(row => row.name)
  ).toEqual(['', '', '']);
  expect(launchNamingPreview({ ...draft, campaignCount: 5, maxBudget: 3 }, launchSources)).toEqual(
    []
  );
});
