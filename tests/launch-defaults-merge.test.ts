import { describe, expect, it } from 'vitest';
import {
  applyDefaultsMask,
  builtinLaunchDraft,
  changedDefaultPaths,
  isLaunchDefaultPath,
  launchDayInZone,
  newDraftFromDefaults,
  resolveLaunchDefaults,
  type LaunchDefaultsProfile
} from '@video-compressor/shared';

const now = new Date('2026-11-21T21:30:00Z'); // 23:30 in Kyiv
const kyiv = 'Europe/Kyiv';

const sub = { schemaVersion: 1 as const, sub1: ['buyer' as const], sub2: [], sub3: [] };

function profile(config: LaunchDefaultsProfile['config']): LaunchDefaultsProfile {
  return { config, subConfig: sub, version: 'v1' };
}

describe('064 launch defaults without a browser', () => {
  it('computes a calendar day in the launch zone, not in UTC', () => {
    expect(launchDayInZone(now, kyiv)).toBe('2026-11-21');
    expect(launchDayInZone(now, kyiv, 1)).toBe('2026-11-22');
    expect(launchDayInZone(new Date('2026-11-21T22:30:00Z'), kyiv)).toBe('2026-11-22');
    expect(() => launchDayInZone(now, 'Mars/Base')).toThrow('INVALID_INPUT');
  });

  it('builds the same built-in draft the form starts from', () => {
    const draft = builtinLaunchDraft(now, kyiv);
    expect(draft).toMatchObject({
      campaignCount: 3,
      minBudget: 10,
      maxBudget: 30,
      budgetMode: 'auto',
      method: 'catalog',
      launchDate: '2026-11-22',
      timezone: kyiv,
      catalog: { productCount: 100, restitchEnabled: false }
    });
  });

  it('prefers the offer profile, then the space profile, then built-in values', () => {
    const offer = profile({
      catalog: { ...builtinLaunchDraft(now, kyiv).catalog!, productCount: 60 }
    });
    const workspace = profile({ campaignCount: 7 });
    expect(newDraftFromDefaults({ offer, workspace, now, timezone: kyiv })).toMatchObject({
      source: 'offer',
      draft: { catalog: { productCount: 60 } }
    });
    expect(newDraftFromDefaults({ offer: null, workspace, now, timezone: kyiv })).toMatchObject({
      source: 'workspace',
      draft: { campaignCount: 7 }
    });
    expect(newDraftFromDefaults({ offer: null, workspace: null, now, timezone: kyiv }).source).toBe(
      'builtin'
    );
  });

  it('keeps a legacy profile without a minimum budget on max/count allocation', () => {
    const legacy = profile({ maxBudget: 50 });
    expect(resolveLaunchDefaults(legacy, now, kyiv).minBudget).toBeUndefined();
  });

  it('saves only the masked fields and carries everything else over as stored', () => {
    const stored = {
      config: {
        maxBudget: 40,
        campaignCount: 2,
        catalog: {
          productCount: 60,
          restitchEnabled: true,
          finalDurationMode: 'custom' as const,
          customFinalDurationSeconds: 45
        },
        legacyFlag: 'kept'
      } as never,
      subConfig: sub
    };
    const next = applyDefaultsMask(stored, ['catalog.productCount'], {
      catalog: { productCount: 100 } as never,
      maxBudget: 999
    });
    expect(next.config).toEqual({
      ...(stored.config as object),
      catalog: { ...(stored.config as { catalog: object }).catalog, productCount: 100 }
    });
    expect(next.subConfig).toEqual(sub);
    expect(
      changedDefaultPaths(stored.config, next.config, ['catalog.productCount', 'maxBudget'])
    ).toEqual(['catalog.productCount']);
  });

  it('accepts only default fields and known catalog/SUB keys as mask paths', () => {
    expect(isLaunchDefaultPath('campaignCount')).toBe(true);
    expect(isLaunchDefaultPath('catalog.copyVideoToR2')).toBe(true);
    expect(isLaunchDefaultPath('subConfig.sub2')).toBe(true);
    expect(isLaunchDefaultPath('offerId')).toBe(false);
    expect(isLaunchDefaultPath('creatives')).toBe(false);
    expect(isLaunchDefaultPath('catalog.__proto__')).toBe(false);
  });
});
