import { useI18n } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import {
  emblemSrc,
  type CreativeRankFreshness,
  type CreativeRankLeague
} from './creativeRanks';

export const LEAGUE_LABEL: Record<CreativeRankLeague, TranslationKey> = {
  wax: 'creativeRankLeagueWax',
  bronze: 'creativeRankLeagueBronze',
  silver: 'creativeRankLeagueSilver',
  gold: 'creativeRankLeagueGold',
  diamond: 'creativeRankLeagueDiamond'
};

export const FRESHNESS_LABEL: Record<CreativeRankFreshness, TranslationKey> = {
  fresh: 'creativeRankFresh',
  dusty: 'creativeRankDusty',
  cobweb: 'creativeRankCobweb'
};

/**
 * A creative's league and freshness as its emblem (059). The picture carries no meaning the text
 * does not: its name is spoken, and the exact count and date sit beside it in plain text.
 */
export function RankEmblem({
  league,
  freshness,
  size,
  facts
}: {
  league: CreativeRankLeague;
  freshness: CreativeRankFreshness;
  size: 'tile' | 'list' | 'detail';
  /** The exact facts, added to the hover title where they are not printed beside it. */
  facts?: string;
}) {
  const { t } = useI18n();
  const label = t('creativeRankEmblemLabel', {
    league: t(LEAGUE_LABEL[league]),
    freshness: t(FRESHNESS_LABEL[freshness])
  });
  return (
    <img
      className={`creative-rank-emblem creative-rank-emblem-${size}`}
      src={emblemSrc(league, freshness, size === 'detail' ? 128 : 64)}
      alt={label}
      title={facts ? `${label} · ${facts}` : label}
      draggable={false}
      decoding="async"
      loading="lazy"
    />
  );
}
