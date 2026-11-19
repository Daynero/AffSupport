/**
 * 059 — creative ranks (honey leagues).
 *
 * The database keeps two numbers per video: how many times it was launched (only grows) and the
 * league credit (grows with it, falls only by the owner's hand), plus when it was last launched.
 * Everything a person sees is derived here, from those numbers and these thresholds — the one
 * place they live. Changing a threshold needs no migration.
 *
 * Kept out of `packages/shared` on purpose: a shared change ships through the full release runner,
 * and this feature is web + backend only.
 */

export const CREATIVE_RANK_LEAGUE_IDS = ['wax', 'bronze', 'silver', 'gold', 'diamond'] as const;
export type CreativeRankLeague = (typeof CREATIVE_RANK_LEAGUE_IDS)[number];

/**
 * Minimum league credit for each league, lowest first. Wax is the first launch: below it a video
 * has no rank at all. Diamond sits at about 25 launches: past that a creative is usually reworked
 * (made unique) and lives on as a different video.
 */
export const CREATIVE_RANK_LEAGUES: readonly { id: CreativeRankLeague; min: number }[] = [
  { id: 'wax', min: 1 },
  { id: 'bronze', min: 3 },
  { id: 'silver', min: 6 },
  { id: 'gold', min: 12 },
  { id: 'diamond', min: 25 }
];

export const CREATIVE_RANK_FRESHNESS_IDS = ['fresh', 'dusty', 'cobweb'] as const;
export type CreativeRankFreshness = (typeof CREATIVE_RANK_FRESHNESS_IDS)[number];

/** Days since the last launch: up to `fresh` is fresh, up to `dusty` is dusty, older is cobweb. */
export const CREATIVE_RANK_FRESHNESS_DAYS = { fresh: 14, dusty: 60 } as const;

export const CREATIVE_RANK_DEMOTE_REASONS = ['disappointed', 'never_launched'] as const;
export type CreativeRankDemoteReason = (typeof CREATIVE_RANK_DEMOTE_REASONS)[number];

export interface CreativeRank {
  materialId: string;
  launchCount: number;
  rankCredit: number;
  lastLaunchedAt: string | null;
  version: number;
  demotion: { reason: CreativeRankDemoteReason; at: string } | null;
}

const DAY_MS = 86_400_000;

/**
 * The league a credit has earned, or null below Wax: a video never launched — or demoted all the
 * way down — has no rank, and a shelf (tile, list row) shows nothing for it.
 */
export function leagueOf(credit: number): CreativeRankLeague | null {
  let league: CreativeRankLeague | null = null;
  for (const step of CREATIVE_RANK_LEAGUES) {
    if (credit >= step.min) league = step.id;
  }
  return league;
}

/**
 * What can carry a rank: the creatives a Launch puts in front of an audience — videos, and images
 * (image Launches are coming; the database already credits whatever material a Launch names).
 */
export function carriesRank(row: { kind: string }): boolean {
  return row.kind === 'video' || row.kind === 'image';
}

/** Whole days since `lastLaunchedAt`; a future time (clock skew) is today. */
export function daysSince(lastLaunchedAt: string | null, now: number): number | null {
  if (!lastLaunchedAt) return null;
  const at = Date.parse(lastLaunchedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** No launch date is not dust: a creative is dusty only once a launch has gone stale. */
export function freshnessOf(lastLaunchedAt: string | null, now: number): CreativeRankFreshness {
  const days = daysSince(lastLaunchedAt, now);
  if (days === null || days <= CREATIVE_RANK_FRESHNESS_DAYS.fresh) return 'fresh';
  return days <= CREATIVE_RANK_FRESHNESS_DAYS.dusty ? 'dusty' : 'cobweb';
}

/**
 * Where a demotion lands. "Disappointed" drops one league (from Wax: to no rank); "never launched"
 * takes the rank away. Null when there is no rank to lower. `league: null` is "no rank".
 */
export function demotionTarget(
  credit: number,
  reason: CreativeRankDemoteReason
): { league: CreativeRankLeague | null; credit: number } | null {
  const league = leagueOf(credit);
  if (league === null) return null;
  const index = CREATIVE_RANK_LEAGUE_IDS.indexOf(league);
  if (reason === 'never_launched' || index === 0) return { league: null, credit: 0 };
  const target = CREATIVE_RANK_LEAGUES[index - 1];
  return { league: target.id, credit: target.min };
}

/**
 * The emblem file for a league and state; files sit in `apps/web/public/creative-ranks/`.
 *
 * Every file is the same square canvas with the honeycomb at its centre and the same size in all
 * five leagues: a higher league is not a bigger cell, it wears more around it (wings, crown,
 * laurels), which is what makes it read larger. `size` is the canvas edge in pixels.
 */
export function emblemSrc(
  league: CreativeRankLeague,
  freshness: CreativeRankFreshness,
  size: 128 | 256
): string {
  const order = CREATIVE_RANK_LEAGUE_IDS.indexOf(league) + 1;
  return `/creative-ranks/${order}_${league}_${freshness}-${size}.webp`;
}

/** A video with no rank row has never been launched. */
export function emptyRank(materialId: string): CreativeRank {
  return {
    materialId,
    launchCount: 0,
    rankCredit: 0,
    lastLaunchedAt: null,
    version: 0,
    demotion: null
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isReason = (value: unknown): value is CreativeRankDemoteReason =>
  typeof value === 'string' && (CREATIVE_RANK_DEMOTE_REASONS as readonly string[]).includes(value);

export function parseCreativeRank(value: unknown): ParseResult<CreativeRank> {
  if (!isRecord(value)) return { ok: false, error: 'rank is not an object' };
  const { materialId, launchCount, rankCredit, lastLaunchedAt, version, demotion } = value;
  if (typeof materialId !== 'string' || materialId.length === 0) {
    return { ok: false, error: 'rank has no material id' };
  }
  if (!isCount(launchCount) || !isCount(rankCredit) || !isCount(version)) {
    return { ok: false, error: 'rank counts are not whole numbers' };
  }
  if (lastLaunchedAt !== null && typeof lastLaunchedAt !== 'string') {
    return { ok: false, error: 'rank last launch is not a time' };
  }
  let parsedDemotion: CreativeRank['demotion'] = null;
  if (demotion !== null && demotion !== undefined) {
    if (!isRecord(demotion) || !isReason(demotion.reason) || typeof demotion.at !== 'string') {
      return { ok: false, error: 'rank demotion is malformed' };
    }
    parsedDemotion = { reason: demotion.reason, at: demotion.at };
  }
  return {
    ok: true,
    value: {
      materialId,
      launchCount,
      rankCredit,
      lastLaunchedAt,
      version,
      demotion: parsedDemotion
    }
  };
}

export function parseCreativeRankList(value: unknown): ParseResult<CreativeRank[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'ranks are not a list' };
  const ranks: CreativeRank[] = [];
  for (const entry of value) {
    const parsed = parseCreativeRank(entry);
    if (!parsed.ok) return parsed;
    ranks.push(parsed.value);
  }
  return { ok: true, value: ranks };
}

/**
 * Why a demotion did not apply, when the answer is about the rank itself: someone else changed it
 * first (`conflict`, with the current rank when the server sent it) or it is not lower (`not_lower`).
 * Permission and transport failures stay `TeamApiError`s.
 */
export class CreativeRankDemoteError extends Error {
  readonly reason: 'conflict' | 'not_lower';
  readonly current: CreativeRank | null;

  constructor(reason: 'conflict' | 'not_lower', current: CreativeRank | null) {
    super(reason === 'conflict' ? 'RANK_CONFLICT' : 'RANK_NOT_LOWER');
    this.name = 'CreativeRankDemoteError';
    this.reason = reason;
    this.current = current;
  }
}

/** Reads the rank the server attached to a refused demotion, if it attached one. */
export function rankFromErrorDetail(detail: unknown): CreativeRank | null {
  if (typeof detail !== 'string' || detail.length === 0) return null;
  try {
    const parsed = parseCreativeRank(JSON.parse(detail) as unknown);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
