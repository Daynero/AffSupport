import { launchCountKey, useI18n } from '../../i18n';
import {
  CREATIVE_RANK_LEAGUE_IDS,
  CREATIVE_RANK_LEAGUES,
  emblemSrc,
  leagueOf
} from './creativeRanks';
import { LEAGUE_LABEL } from './RankEmblem';

/**
 * How the leagues are earned, as a ladder of five small combs under the card (059): the ones
 * already reached in colour, the current one held in a honey frame, the ones ahead faded — each
 * with its threshold beneath. One line under it says how far the next league is.
 *
 * The emblems here are decoration: each step's name and threshold are printed, so the pictures
 * carry no meaning of their own and are hidden from assistive technology.
 */
export function RankLadder({ credit }: { credit: number }) {
  const { t, language } = useI18n();
  const league = leagueOf(credit);
  const currentIndex = league === null ? -1 : CREATIVE_RANK_LEAGUE_IDS.indexOf(league);
  const next = CREATIVE_RANK_LEAGUES[currentIndex + 1];
  const remaining = next ? next.min - credit : 0;

  return (
    <div className="creative-rank-ladder">
      <ol className="creative-rank-ladder-steps" aria-label={t('creativeRankLadder')}>
        {CREATIVE_RANK_LEAGUES.map((step, index) => {
          const state =
            index < currentIndex ? 'reached' : index === currentIndex ? 'current' : 'ahead';
          return (
            <li
              key={step.id}
              className="creative-rank-ladder-step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <img
                className="creative-rank-ladder-emblem"
                src={emblemSrc(step.id, 'fresh', 128)}
                alt=""
                draggable={false}
                decoding="async"
                loading="lazy"
              />
              <span className="creative-rank-ladder-name">{t(LEAGUE_LABEL[step.id])}</span>
              <span className="creative-rank-ladder-min">{step.min}+</span>
            </li>
          );
        })}
      </ol>
      {next && (
        <p className="creative-rank-ladder-next">
          {t('creativeRankNextLeague', {
            league: t(LEAGUE_LABEL[next.id]),
            launches: t(launchCountKey(language, remaining), { count: String(remaining) })
          })}
        </p>
      )}
    </div>
  );
}
