import { useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button, DropdownMenu } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { teamApi, TeamApiError } from '../../api/team';
import { creativeRankDemoteFinished, creativeRankDemoteStarted } from './analytics';
import {
  CREATIVE_RANK_LEAGUES,
  CreativeRankDemoteError,
  demotionTarget,
  emptyRank,
  freshnessOf,
  leagueOf,
  type CreativeRank,
  type CreativeRankDemoteReason
} from './creativeRanks';
import { FRESHNESS_LABEL, LEAGUE_LABEL, RankEmblem } from './RankEmblem';
import { RankFacts } from './RankFacts';
import { useCreativeRanks, type CreativeRanksClient } from './useCreativeRanks';
import type { CreativeRankDemoteResult } from './analytics';

export interface MaterialRankClient extends CreativeRanksClient {
  demoteCreativeRank?: (typeof teamApi)['demoteCreativeRank'];
}

const REASONS: readonly { id: CreativeRankDemoteReason; label: TranslationKey }[] = [
  { id: 'disappointed', label: 'creativeRankReasonDisappointed' },
  { id: 'never_launched', label: 'creativeRankReasonNeverLaunched' }
];

const MESSAGE: Partial<Record<CreativeRankDemoteResult, TranslationKey>> = {
  rank_conflict: 'creativeRankDemoteConflict',
  rank_not_lower: 'creativeRankDemoteConflict',
  permission_denied: 'creativeRankDemoteDenied',
  failed: 'creativeRankDemoteFailed'
};

function newFlowId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rank-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A video's honey league in its card (059, US3): the big emblem, the league and its state, the
 * exact count and the last launch — and, for the space's owner, the way down with a reason.
 *
 * Two presses: "Lower the rank", then why. No confirmation: new launches lift it again, and the
 * launch count it shows never changes.
 */
export function MaterialRank({
  teamId,
  materialId,
  isOwner,
  ranksRevision,
  client = teamApi
}: {
  teamId: string;
  materialId: string;
  isOwner: boolean;
  ranksRevision: number;
  client?: MaterialRankClient;
}) {
  const { t } = useI18n();
  const read = useCreativeRanks(teamId, [materialId], ranksRevision, client);
  const [local, setLocal] = useState<CreativeRank | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<TranslationKey | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A retry of a demotion that never got an answer reuses its key: if the first one did land, the
  // server answers with that same demotion instead of calling the retry a conflict.
  const retry = useRef<{ attempt: string; key: string } | null>(null);

  if (!read.known) return null;
  const fetched = read.ranks.get(materialId) ?? emptyRank(materialId);
  // What this card just wrote stays until the space's own read catches up with it.
  const rank =
    local && local.materialId === materialId && local.version >= fetched.version ? local : fetched;
  const league = leagueOf(rank.rankCredit);
  const freshness = freshnessOf(rank.lastLaunchedAt, read.now);

  const demote = async (reason: CreativeRankDemoteReason) => {
    const target = demotionTarget(rank.rankCredit, reason);
    if (!target || !client.demoteCreativeRank) return;
    const attempt = `${rank.version}:${reason}:${target.credit}`;
    const flowId = retry.current?.attempt === attempt ? retry.current.key : newFlowId();
    retry.current = { attempt, key: flowId };
    const trace = { flowId, reason, from: league, to: target.league };
    creativeRankDemoteStarted(trace);
    setPending(true);
    setMessage(null);
    let result: CreativeRankDemoteResult = 'failed';
    try {
      const next = await client.demoteCreativeRank({
        teamId,
        materialId,
        reason,
        targetCredit: target.credit,
        expectedVersion: rank.version,
        requestKey: flowId
      });
      setLocal(next);
      result = 'applied';
    } catch (cause) {
      if (cause instanceof CreativeRankDemoteError) {
        result = cause.reason === 'conflict' ? 'rank_conflict' : 'rank_not_lower';
        if (cause.current) setLocal(cause.current);
      } else if (cause instanceof TeamApiError && cause.code === 'PERMISSION_DENIED') {
        result = 'permission_denied';
      }
      setMessage(MESSAGE[result] ?? 'creativeRankDemoteFailed');
    } finally {
      // Only an unanswered attempt is retried with its key; any answer settles it.
      if (result !== 'failed') retry.current = null;
      setPending(false);
      creativeRankDemoteFinished({ ...trace, result });
    }
  };

  return (
    <section className="creative-rank-card" aria-label={t('creativeRankTitle')}>
      <RankEmblem league={league} freshness={freshness} size="detail" />
      <div className="creative-rank-card-body">
        <p className="creative-rank-card-league">
          {t(LEAGUE_LABEL[league])}
          <span className="creative-rank-card-state"> · {t(FRESHNESS_LABEL[freshness])}</span>
        </p>
        <RankFacts rank={rank} now={read.now} />
        <p className="creative-rank-card-legend">
          {t('creativeRankLegend', {
            steps: CREATIVE_RANK_LEAGUES.filter(step => step.min > 0)
              .map(step => `${t(LEAGUE_LABEL[step.id])} ${step.min}+`)
              .join(' · ')
          })}
        </p>
        {isOwner && client.demoteCreativeRank && (
          <>
            <Button
              ref={trigger}
              type="button"
              size="sm"
              variant="ghost"
              loading={pending}
              disabled={pending}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              leading={<ArrowDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              onClick={() => setMenuOpen(true)}
            >
              {t('creativeRankDemote')}
            </Button>
            <DropdownMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchor={trigger}
              placement="bottom-start"
              label={t('creativeRankDemote')}
              items={[
                { heading: t('creativeRankDemoteWhy') },
                ...REASONS.map(reason => {
                  const target = demotionTarget(rank.rankCredit, reason.id);
                  return {
                    id: reason.id,
                    label: t(reason.label),
                    disabled: target === null,
                    trailing: target ? t(LEAGUE_LABEL[target.league]) : undefined,
                    note: target === null ? t('creativeRankDemoteNowhere') : undefined,
                    onSelect: () => void demote(reason.id)
                  };
                })
              ]}
            />
          </>
        )}
        {message && (
          <p className="creative-rank-card-message" role="status">
            {t(message)}
          </p>
        )}
      </div>
    </section>
  );
}
