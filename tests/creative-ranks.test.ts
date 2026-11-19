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
import type { CreativeRank } from '../apps/web/src/team/ranks/creativeRanks';
import { launchedAgo } from '../apps/web/src/team/ranks/RankFacts';
import { sortRows, DEFAULT_SORT } from '../apps/web/src/team/explorer/sort';
import type { TeamMaterialRow } from '@video-compressor/shared';

/**
 * Feature 059: a creative's honey league comes from its league credit, its freshness from the
 * last launch. The thresholds live in one table; these tests pin the edges of each.
 */

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe('leagues', () => {
  it.each([
    [0, null],
    [1, 'wax'],
    [2, 'wax'],
    [3, 'bronze'],
    [5, 'bronze'],
    [6, 'silver'],
    [11, 'silver'],
    [12, 'gold'],
    [24, 'gold'],
    [25, 'diamond'],
    [1000, 'diamond']
  ])('credit %i is %s', (credit, league) => {
    expect(leagueOf(credit)).toBe(league);
  });

  it('keeps the thresholds in one ascending table', () => {
    const mins = CREATIVE_RANK_LEAGUES.map(step => step.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    // Wax is the first launch: below it there is no rank.
    expect(mins[0]).toBe(1);
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

  it('reads a never-launched creative as fresh, not as dust', () => {
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
    expect(demotionTarget(20, 'disappointed')).toEqual({ league: 'silver', credit: 6 });
    expect(demotionTarget(6, 'disappointed')).toEqual({ league: 'bronze', credit: 3 });
    expect(demotionTarget(3, 'disappointed')).toEqual({ league: 'wax', credit: 1 });
    expect(demotionTarget(2, 'disappointed')).toEqual({ league: null, credit: 0 });
  });

  it('climbs back from a demotion launch by launch, not at once', () => {
    // 60 launches is Diamond; the owner lowers it to Gold, then it is launched once more.
    const target = demotionTarget(60, 'disappointed');
    expect(target).toEqual({ league: 'gold', credit: 12 });
    expect(leagueOf(target!.credit + 1)).toBe('gold');
    // Diamond again only after 25 − 12 = 13 launches since the demotion.
    expect(leagueOf(target!.credit + 12)).toBe('gold');
    expect(leagueOf(target!.credit + 13)).toBe('diamond');
  });

  it('takes the rank away when the creative was never launched', () => {
    expect(demotionTarget(74, 'never_launched')).toEqual({ league: null, credit: 0 });
    expect(demotionTarget(1, 'never_launched')).toEqual({ league: null, credit: 0 });
  });

  it('has nowhere to go without a rank', () => {
    expect(demotionTarget(0, 'disappointed')).toBeNull();
    expect(demotionTarget(0, 'never_launched')).toBeNull();
  });
});

describe('emblems', () => {
  it('names the file by league order, league and state', () => {
    expect(emblemSrc('gold', 'dusty', 128)).toBe('/creative-ranks/4_gold_dusty-128.webp');
    expect(emblemSrc('wax', 'fresh', 256)).toBe('/creative-ranks/1_wax_fresh-256.webp');
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

describe('on a shelf', () => {
  const base: CreativeRank = {
    materialId: 'v1',
    launchCount: 0,
    rankCredit: 0,
    lastLaunchedAt: null,
    version: 0,
    demotion: null
  };

  it('marks a creative launched once as Wax and leaves one with no rank unmarked', () => {
    expect(leagueOf({ ...base, launchCount: 1, rankCredit: 1 }.rankCredit)).toBe('wax');
    expect(leagueOf(base.rankCredit)).toBeNull();
    // Demoted all the way down: launched, but the owner says it never really ran.
    expect(leagueOf({ ...base, launchCount: 9, rankCredit: 0 }.rankCredit)).toBeNull();
  });
});

describe('sorting by rank', () => {
  const row = (id: string, name: string, kind = 'video') =>
    ({ id, name, kind, modifiedAt: null, tagColor: null }) as unknown as TeamMaterialRow;
  const rank = (id: string, credit: number, days: number): [string, CreativeRank] => [
    id,
    {
      materialId: id,
      launchCount: credit,
      rankCredit: credit,
      lastLaunchedAt: daysAgo(days),
      version: 1,
      demotion: null
    }
  ];
  const rows = [
    row('a', 'a.mp4'),
    row('b', 'b.mp4'),
    row('c', 'c.mp4'),
    row('d', 'd.mp4'),
    row('f', 'Folder', 'folder')
  ];
  const ranks = new Map([rank('b', 3, 40), rank('c', 30, 5), rank('d', 3, 2)]);

  it('puts the strongest first, the most recent launch breaking a tie', () => {
    const sorted = sortRows(rows, { ...DEFAULT_SORT, key: 'rank', direction: 'desc' }, ranks);
    expect(sorted.map(r => r.id)).toEqual(['f', 'c', 'd', 'b', 'a']);
  });

  it('keeps never-launched videos last in either direction', () => {
    const sorted = sortRows(rows, { key: 'rank', direction: 'asc', foldersSeparate: false }, ranks);
    expect(sorted.map(r => r.id).slice(-2)).toEqual(['a', 'f']);
    expect(sorted[0].id).toBe('b');
  });
});

describe('how long ago', () => {
  it('counts days up to the end of dusty, then months', () => {
    expect(launchedAgo(daysAgo(1), 'uk', NOW)).toBe('учора');
    expect(launchedAgo(daysAgo(32), 'uk', NOW)).toBe('32 дні тому');
    expect(launchedAgo(daysAgo(60), 'en', NOW)).toBe('60 days ago');
    expect(launchedAgo(daysAgo(95), 'en', NOW)).toBe('3 months ago');
  });
});
