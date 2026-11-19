import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button, DropdownMenu } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { teamApi, TeamApiError } from '../../api/team';
import {
  creativeRankDemoteFinished,
  creativeRankDemoteStarted,
  creativeRankPromoteFinished,
  creativeRankPromoteStarted
} from './analytics';
import {
  CreativeRankDemoteError,
  demotionTarget,
  emptyRank,
  freshnessOf,
  leagueOf,
  promotionTarget,
  type CreativeRank,
  type CreativeRankDemoteReason
} from './creativeRanks';
import { FRESHNESS_LABEL, LEAGUE_LABEL, RankEmblem } from './RankEmblem';
import { RankFacts } from './RankFacts';
import { RankLadder } from './RankLadder';
import { useCreativeRanks, type CreativeRanksClient } from './useCreativeRanks';
import type { CreativeRankDemoteResult, CreativeRankStanding } from './analytics';

export interface MaterialRankClient extends CreativeRanksClient {
  demoteCreativeRank?: (typeof teamApi)['demoteCreativeRank'];
  promoteCreativeRank?: (typeof teamApi)['promoteCreativeRank'];
}

const REASONS: readonly { id: CreativeRankDemoteReason; label: TranslationKey }[] = [
  { id: 'disappointed', label: 'creativeRankReasonDisappointed' },
  { id: 'never_launched', label: 'creativeRankReasonNeverLaunched' }
];

type Direction = 'demote' | 'promote';

const MESSAGE: Record<Direction, Partial<Record<CreativeRankDemoteResult, TranslationKey>>> = {
  demote: {
    rank_conflict: 'creativeRankDemoteConflict',
    rank_not_lower: 'creativeRankDemoteConflict',
    rank_not_higher: 'creativeRankDemoteConflict',
    permission_denied: 'creativeRankDemoteDenied',
    failed: 'creativeRankDemoteFailed'
  },
  promote: {
    rank_conflict: 'creativeRankDemoteConflict',
    rank_not_lower: 'creativeRankDemoteConflict',
    rank_not_higher: 'creativeRankDemoteConflict',
    permission_denied: 'creativeRankPromoteDenied',
    failed: 'creativeRankPromoteFailed'
  }
};

function newFlowId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rank-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A creative's honey league in its card (059, US3): the big emblem, the league and its state, the
 * exact count and the last launch, the ladder of leagues — and, for the space's owner, the way
 * down with a reason and the way back up.
 *
 * Down is two presses: "Lower the rank", then why. Up is one: it only undoes a demotion — one
 * league per press, never past what the launches earned — and the launch count never changes.
 * No confirmation either way: each undoes the other.
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
  const [pending, setPending] = useState<Direction | null>(null);
  const [message, setMessage] = useState<TranslationKey | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A retry of a change that never got an answer reuses its key: if the first one did land, the
  // server answers with that same change instead of calling the retry a conflict.
  const retry = useRef<{ attempt: string; key: string } | null>(null);

  if (!read.known) return null;
  const fetched = read.ranks.get(materialId) ?? emptyRank(materialId);
  // What this card just wrote stays until the space's own read catches up with it.
  const rank =
    local && local.materialId === materialId && local.version >= fetched.version ? local : fetched;
  const league = leagueOf(rank.rankCredit);
  const freshness = freshnessOf(rank.lastLaunchedAt, read.now);
  const raise = promotionTarget(rank);
  const canDemote = isOwner && league !== null && Boolean(client.demoteCreativeRank);
  const canPromote = isOwner && raise !== null && Boolean(client.promoteCreativeRank);

  const change = async (
    direction: Direction,
    attempt: string,
    send: (requestKey: string) => Promise<CreativeRank>,
    track: {
      started: (flowId: string) => void;
      finished: (flowId: string, result: CreativeRankDemoteResult) => void;
    }
  ) => {
    const flowId = retry.current?.attempt === attempt ? retry.current.key : newFlowId();
    retry.current = { attempt, key: flowId };
    track.started(flowId);
    setPending(direction);
    setMessage(null);
    let result: CreativeRankDemoteResult = 'failed';
    try {
      setLocal(await send(flowId));
      result = 'applied';
    } catch (cause) {
      if (cause instanceof CreativeRankDemoteError) {
        result =
          cause.reason === 'conflict'
            ? 'rank_conflict'
            : cause.reason === 'not_lower'
              ? 'rank_not_lower'
              : 'rank_not_higher';
        if (cause.current) setLocal(cause.current);
      } else if (cause instanceof TeamApiError && cause.code === 'PERMISSION_DENIED') {
        result = 'permission_denied';
      }
      setMessage(MESSAGE[direction][result] ?? 'creativeRankDemoteFailed');
    } finally {
      // Only an unanswered attempt is retried with its key; any answer settles it.
      if (result !== 'failed') retry.current = null;
      setPending(null);
      track.finished(flowId, result);
    }
  };

  const from: CreativeRankStanding = league ?? 'unranked';

  const demote = (reason: CreativeRankDemoteReason) => {
    const target = demotionTarget(rank.rankCredit, reason);
    if (!target || !client.demoteCreativeRank) return;
    const to: CreativeRankStanding = target.league ?? 'unranked';
    const send = client.demoteCreativeRank;
    void change(
      'demote',
      `down:${rank.version}:${reason}:${target.credit}`,
      requestKey =>
        send({
          teamId,
          materialId,
          reason,
          targetCredit: target.credit,
          expectedVersion: rank.version,
          requestKey
        }),
      {
        started: flowId => creativeRankDemoteStarted({ flowId, reason, from, to }),
        finished: (flowId, result) =>
          creativeRankDemoteFinished({ flowId, reason, from, to, result })
      }
    );
  };

  const promote = () => {
    if (!raise || !client.promoteCreativeRank) return;
    const to: CreativeRankStanding = raise.league;
    const send = client.promoteCreativeRank;
    void change(
      'promote',
      `up:${rank.version}:${raise.credit}`,
      requestKey =>
        send({
          teamId,
          materialId,
          targetCredit: raise.credit,
          expectedVersion: rank.version,
          requestKey
        }),
      {
        started: flowId => creativeRankPromoteStarted({ flowId, from, to }),
        finished: (flowId, result) => creativeRankPromoteFinished({ flowId, from, to, result })
      }
    );
  };

  return (
    <section className="creative-rank-card" aria-label={t('creativeRankTitle')}>
      <div className="creative-rank-card-head">
        {league && <RankEmblem league={league} freshness={freshness} size="detail" />}
        <div className="creative-rank-card-body">
          <p className="creative-rank-card-league">
            {league ? t(LEAGUE_LABEL[league]) : t('creativeRankUnranked')}
            {league && (
              <span className="creative-rank-card-state"> · {t(FRESHNESS_LABEL[freshness])}</span>
            )}
          </p>
          <RankFacts rank={rank} now={read.now} />
          {(canPromote || canDemote) && (
            <div className="creative-rank-card-actions">
              {canPromote && raise && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={pending === 'promote'}
                  disabled={pending !== null}
                  title={t(LEAGUE_LABEL[raise.league])}
                  leading={
                    <ArrowUp size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  }
                  onClick={promote}
                >
                  {t('creativeRankPromote')}
                </Button>
              )}
              {canDemote && (
                <>
                  <Button
                    ref={trigger}
                    type="button"
                    size="sm"
                    variant="ghost"
                    loading={pending === 'demote'}
                    disabled={pending !== null}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    leading={
                      <ArrowDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    }
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
                          trailing: target
                            ? target.league
                              ? t(LEAGUE_LABEL[target.league])
                              : t('creativeRankUnranked')
                            : undefined,
                          note: target === null ? t('creativeRankDemoteNowhere') : undefined,
                          onSelect: () => demote(reason.id)
                        };
                      })
                    ]}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <RankLadder credit={rank.rankCredit} />
      {message && (
        <p className="creative-rank-card-message" role="status">
          {t(message)}
        </p>
      )}
    </section>
  );
}
