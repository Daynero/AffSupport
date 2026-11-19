import { analytics } from '../../analytics/service';
import type { CreativeRankDemoteReason, CreativeRankLeague } from './creativeRanks';

/** A league, or `unranked` below Wax (never launched, or demoted all the way down). */
export type CreativeRankStanding = CreativeRankLeague | 'unranked';

type AnalyticsTracker = Pick<typeof analytics, 'track'>;

/** What the server said about a demotion, in the closed words the CLI reads back. */
export type CreativeRankDemoteResult =
  | 'applied'
  | 'rank_conflict'
  | 'rank_not_lower'
  | 'rank_not_higher'
  | 'permission_denied'
  | 'failed';

/** Analytics tokens allow `[a-z0-9._:-]`, never `_`: `never_launched` travels as `never-launched`. */
const token = (value: string) => value.replaceAll('_', '-');

function emit(record: () => void) {
  // Telemetry must never turn a committed demotion into a visible failure.
  try {
    record();
  } catch {
    // Missing delivery is reported by the coverage registry as a blind spot.
  }
}

export function creativeRankDemoteStarted(
  input: {
    flowId: string;
    reason: CreativeRankDemoteReason;
    from: CreativeRankStanding;
    to: CreativeRankStanding;
  },
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('creative_rank_demote_started', {
      flow_id: input.flowId,
      feature_identifier: 'creative-rank',
      action_identifier: token(input.reason),
      source_kind: input.from,
      input_method: input.to
    })
  );
}

export function creativeRankDemoteFinished(
  input: {
    flowId: string;
    reason: CreativeRankDemoteReason;
    from: CreativeRankStanding;
    to: CreativeRankStanding;
    result: CreativeRankDemoteResult;
  },
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('creative_rank_demote_finished', {
      flow_id: input.flowId,
      feature_identifier: 'creative-rank',
      action_identifier: token(input.reason),
      source_kind: input.from,
      input_method: input.to,
      outcome:
        input.result === 'applied'
          ? 'success'
          : input.result === 'permission_denied'
            ? 'blocked'
            : 'failure',
      error_code: token(input.result)
    })
  );
}

export function creativeRankReadFailed(
  input: { count: number; code: string },
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('creative_rank_read_failed', {
      feature_identifier: 'creative-rank',
      item_count: input.count,
      error_code: token(input.code)
    })
  );
}

/** The owner raises a league back: one press, so `started` and `finished` share the flow id. */
export function creativeRankPromoteStarted(
  input: { flowId: string; from: CreativeRankStanding; to: CreativeRankStanding },
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('creative_rank_promote_started', {
      flow_id: input.flowId,
      feature_identifier: 'creative-rank',
      action_identifier: 'undo',
      source_kind: input.from,
      input_method: input.to
    })
  );
}

export function creativeRankPromoteFinished(
  input: {
    flowId: string;
    from: CreativeRankStanding;
    to: CreativeRankStanding;
    result: CreativeRankDemoteResult;
  },
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('creative_rank_promote_finished', {
      flow_id: input.flowId,
      feature_identifier: 'creative-rank',
      action_identifier: 'undo',
      source_kind: input.from,
      input_method: input.to,
      outcome:
        input.result === 'applied'
          ? 'success'
          : input.result === 'permission_denied'
            ? 'blocked'
            : 'failure',
      error_code: token(input.result)
    })
  );
}
