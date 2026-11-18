import { useI18n } from '../../i18n';
import { daysSince, type CreativeRank } from './creativeRanks';

/** "2 days ago", "3 months ago" — short, in the reader's language; today reads as today. */
export function launchedAgo(
  lastLaunchedAt: string | null,
  language: string,
  now: number
): string | null {
  const days = daysSince(lastLaunchedAt, now);
  if (days === null) return null;
  const format = new Intl.RelativeTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    numeric: 'auto',
    style: 'short'
  });
  if (days < 31) return format.format(-days, 'day');
  if (days < 365) return format.format(-Math.floor(days / 30), 'month');
  return format.format(-Math.floor(days / 365), 'year');
}

/** Counts above this read as "999+×": a number, never a broken tile. */
const COUNT_CAP = 999;

/** The facts as one plain string, for a title or an accessible name. */
export function rankFactsText(
  rank: CreativeRank,
  t: (key: 'creativeRankNever' | 'creativeRankLaunches', values?: Record<string, string>) => string,
  language: string,
  now: number
): string {
  if (rank.launchCount === 0) return t('creativeRankNever');
  const count = rank.launchCount > COUNT_CAP ? `${COUNT_CAP}+` : String(rank.launchCount);
  const ago = launchedAgo(rank.lastLaunchedAt, language, now);
  return ago
    ? `${t('creativeRankLaunches', { count })} · ${ago}`
    : t('creativeRankLaunches', { count });
}

/**
 * The exact facts beside an emblem: `74× · 2 days ago`. Always full contrast — the emblem may
 * gather dust, the facts never do (059 FR-013).
 */
export function RankFacts({
  rank,
  now,
  quietWhenNever = false
}: {
  rank: CreativeRank;
  now: number;
  /** A tile says nothing for a video never launched: the wax emblem already does. */
  quietWhenNever?: boolean;
}) {
  const { t, language } = useI18n();
  if (rank.launchCount === 0) {
    if (quietWhenNever) return null;
    return <span className="creative-rank-facts">{t('creativeRankNever')}</span>;
  }
  return <span className="creative-rank-facts">{rankFactsText(rank, t, language, now)}</span>;
}
