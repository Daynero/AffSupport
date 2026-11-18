import { useEffect, useMemo, useState } from 'react';
import { teamApi, TeamApiError } from '../../api/team';
import { creativeRankReadFailed } from './analytics';
import type { CreativeRank } from './creativeRanks';

export interface CreativeRanksClient {
  listCreativeRanks?: (teamId: string, materialIds: string[]) => Promise<Map<string, CreativeRank>>;
}

export interface CreativeRanksState {
  /** Ranks of the asked videos that have one; a missing id was never launched. */
  ranks: ReadonlyMap<string, CreativeRank>;
  /** False until the first answer and after a failed read: then nothing is drawn, not wax. */
  known: boolean;
  /** When the answer arrived; freshness is measured from it so tiles do not tick on every render. */
  now: number;
}

const EMPTY: ReadonlyMap<string, CreativeRank> = new Map();

/**
 * The ranks of the videos on screen (059), one read per page like the restitch preparation, and
 * again when a rank changes anywhere in the space (`ranksRevision`).
 */
export function useCreativeRanks(
  teamId: string | null,
  videoIds: readonly string[],
  ranksRevision: number,
  client: CreativeRanksClient = teamApi
): CreativeRanksState {
  const key = useMemo(() => [...new Set(videoIds)].sort().join(','), [videoIds]);
  const [state, setState] = useState<CreativeRanksState>(() => ({
    ranks: EMPTY,
    known: false,
    now: Date.now()
  }));

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (!teamId || ids.length === 0 || !client.listCreativeRanks) {
      setState({ ranks: EMPTY, known: ids.length === 0, now: Date.now() });
      return;
    }
    let active = true;
    client
      .listCreativeRanks(teamId, ids)
      .then(ranks => {
        if (active) setState({ ranks, known: true, now: Date.now() });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState(previous =>
          previous.known ? previous : { ranks: EMPTY, known: false, now: previous.now }
        );
        creativeRankReadFailed({
          count: ids.length,
          code: cause instanceof TeamApiError ? cause.code.toLowerCase() : 'unknown'
        });
      });
    return () => {
      active = false;
    };
  }, [client, key, ranksRevision, teamId]);

  return state;
}
