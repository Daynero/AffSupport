import { describe, expect, it } from 'vitest';
import {
  CREATIVE_RANK_LEAGUES,
  daysSince,
  demotionTarget,
  emblemSrc,
  freshnessOf,
  leagueOf,
  parseCreativeRank,
  parseCreativeRankList,
  rankFromErrorDetail
} from '../apps/web/src/team/ranks/creativeRanks';

/**
 * Feature 059: a creative's honey league comes from its league credit, its freshness from the
 * last launch. The thresholds live in one table; these tests pin the edges of each.
 */

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe('leagues', () => {
  it.each([
    [0, 'wax'],
    [1, 'bronze'],
    [4, 'bronze'],
    [5, 'silver'],
    [14, 'silver'],
    [15, 'gold'],
    [39, 'gold'],
    [40, 'diamond'],
    [1000, 'diamond']
  ])('credit %i is %s', (credit, league) => {
    expect(leagueOf(credit)).toBe(league);
  });

  it('keeps the thresholds in one ascending table', () => {
    const mins = CREATIVE_RANK_LEAGUES.map(step => step.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(mins[0]).toBe(0);
  });
});

describe('freshness', () => {
  it.each([
    [0, 'fresh'],
    [14, 'fresh'],
    [15, 'dusty'],
    [60, 'dusty'],
    [61, 'cobweb']
  ])('%i days after the last launch is %s', (days, freshness) => {
    expect(freshnessOf(daysAgo(days), NOW)).toBe(freshness);
  });

  it('reads a never-launched creative as fresh wax, not as dust', () => {
    expect(freshnessOf(null, NOW)).toBe('fresh');
  });

  it('treats a launch dated in the future (clock skew) as today', () => {
    expect(daysSince(daysAgo(-3), NOW)).toBe(0);
    expect(freshnessOf(daysAgo(-3), NOW)).toBe('fresh');
  });

  it('does not invent a date from garbage', () => {
    expect(daysSince('not a date', NOW)).toBeNull();
  });
});

describe('demotion', () => {
  it('drops one league when disappointed', () => {
    expect(demotionTarget(20, 'disappointed')).toEqual({ league: 'silver', credit: 5 });
    expect(demotionTarget(5, 'disappointed')).toEqual({ league: 'bronze', credit: 1 });
    expect(demotionTarget(1, 'disappointed')).toEqual({ league: 'wax', credit: 0 });
  });

  it('drops to wax when the creative was never launched', () => {
    expect(demotionTarget(74, 'never_launched')).toEqual({ league: 'wax', credit: 0 });
  });

  it('has nowhere to go from wax', () => {
    expect(demotionTarget(0, 'disappointed')).toBeNull();
    expect(demotionTarget(0, 'never_launched')).toBeNull();
  });
});

describe('emblems', () => {
  it('names the file by league order, league and state', () => {
    expect(emblemSrc('gold', 'dusty', 64)).toBe('/creative-ranks/4_gold_dusty-64.webp');
    expect(emblemSrc('wax', 'fresh', 128)).toBe('/creative-ranks/1_wax_fresh-128.webp');
  });
});

describe('parsing the server answer', () => {
  const good = {
    materialId: 'v1',
    launchCount: 74,
    rankCredit: 40,
    lastLaunchedAt: daysAgo(2),
    version: 81,
    demotion: { reason: 'disappointed', at: daysAgo(1) }
  };

  it('accepts a well-formed rank and list', () => {
    expect(parseCreativeRank(good)).toEqual({ ok: true, value: good });
    const list = parseCreativeRankList([good, { ...good, materialId: 'v2', demotion: null }]);
    expect(list.ok && list.value.map(rank => rank.materialId)).toEqual(['v1', 'v2']);
  });

  it.each([
    ['a negative count', { ...good, launchCount: -1 }],
    ['a fractional credit', { ...good, rankCredit: 1.5 }],
    ['an unknown reason', { ...good, demotion: { reason: 'bored', at: daysAgo(1) } }],
    ['a missing id', { ...good, materialId: '' }],
    ['a numeric date', { ...good, lastLaunchedAt: 5 }]
  ])('refuses %s', (_name, value) => {
    expect(parseCreativeRank(value).ok).toBe(false);
  });

  it('refuses a list that is not a list, and one bad entry spoils it', () => {
    expect(parseCreativeRankList({}).ok).toBe(false);
    expect(parseCreativeRankList([good, { ...good, version: 'x' }]).ok).toBe(false);
  });

  it('reads the current rank a refused demotion carries, and nothing from noise', () => {
    expect(rankFromErrorDetail(JSON.stringify(good))?.version).toBe(81);
    expect(rankFromErrorDetail('{not json')).toBeNull();
    expect(rankFromErrorDetail(undefined)).toBeNull();
  });
});
