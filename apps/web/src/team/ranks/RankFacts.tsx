import { launchCountKey, useI18n } from '../../i18n';
import type { Language, TranslationKey } from '../../i18n';
import { daysSince, type CreativeRank } from './creativeRanks';

/**
 * "yesterday", "32 days ago", "3 months ago" — in words, in the reader's language. Days up to 60,
 * the edge of "dusty", so the number matches what the emblem says; "last month" is never used —
 * it hides whether that was 31 days or 59.
 */
export function launchedAgo(
  lastLaunchedAt: string | null,
  language: string,
  now: number
): string | null {
  const days = daysSince(lastLaunchedAt, now);
  if (days === null) return null;
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  if (days <= 2) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' }).format(
      -days,
      'day'
    );
  }
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'long' });
  if (days <= 60) return format.format(-days, 'day');
  if (days < 365) return format.format(-Math.floor(days / 30), 'month');
  return format.format(-Math.floor(days / 365), 'year');
}

/** Counts above this read as "999+ launches": a number, never a broken tile. */
const COUNT_CAP = 999;

/** "14", or "999+" past the cap. */
export function launchCountText(rank: CreativeRank): string {
  return rank.launchCount > COUNT_CAP ? `${COUNT_CAP}+` : String(rank.launchCount);
}

/** The facts as one plain string — "14 launches · 32 days ago" — for a caption, title or name. */
export function rankFactsText(
  rank: CreativeRank,
  t: (key: TranslationKey, values?: Record<string, string>) => string,
  language: Language,
  now: number
): string {
  if (rank.launchCount === 0) return t('creativeRankNever');
  const launches = t(launchCountKey(language, Math.min(rank.launchCount, COUNT_CAP)), {
    count: launchCountText(rank)
  });
  const ago = launchedAgo(rank.lastLaunchedAt, language, now);
  return ago ? `${launches} · ${ago}` : launches;
}

/**
 * The exact facts beside an emblem: `14 launches · 2 days ago`. Always full contrast — the emblem
 * may gather dust, the facts never do (059 FR-013).
 */
export function RankFacts({
  rank,
  now,
  quietWhenNever = false
}: {
  rank: CreativeRank;
  now: number;
  /** A tile says nothing for a video never launched: silence is the default state. */
  quietWhenNever?: boolean;
}) {
  const { t, language } = useI18n();
  if (rank.launchCount === 0 && quietWhenNever) return null;
  return <span className="creative-rank-facts">{rankFactsText(rank, t, language, now)}</span>;
}
