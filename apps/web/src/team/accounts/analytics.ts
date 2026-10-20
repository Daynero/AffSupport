import {
  ACCOUNT_ANALYTICS_CODES,
  type AccountAnalyticsAction,
  type AccountAnalyticsStage,
  type TeamAnalyticsProperties
} from '@video-compressor/shared';
import { analytics } from '../../analytics/service';

type Tracker = Pick<typeof analytics, 'track'>;
export type AccountSignal = {
  flowId: string;
  operation?: TeamAnalyticsProperties['account_operation'];
  attemptId?: string;
  code?: unknown;
  outcome?: TeamAnalyticsProperties['outcome'];
  result?: TeamAnalyticsProperties['account_result'];
  entity?: TeamAnalyticsProperties['account_entity'];
  day?: TeamAnalyticsProperties['account_day'];
  coverage?: TeamAnalyticsProperties['account_coverage'];
  count?: number;
  durationMs?: number;
};
/** Keep diagnostic IDs independent of entity IDs, including legacy external РК IDs. */
export function accountFlowId(): string {
  return crypto.randomUUID();
}
export function emitAccountSignal(
  action: AccountAnalyticsAction,
  stage: AccountAnalyticsStage,
  signal: AccountSignal,
  tracker: Tracker = analytics
): void {
  try {
    const event =
      stage === 'applied' || stage === 'clipboard_confirmed'
        ? 'team_account_visible'
        : stage === 'terminal' || stage === 'accepted'
          ? 'team_account_terminal'
          : 'team_account_stage';
    tracker.track(event, {
      flow_id: signal.flowId,
      attempt_id: signal.attemptId,
      account_action: action,
      account_operation: signal.operation,
      account_stage: stage,
      ...(signal.code === undefined
        ? {}
        : {
            account_code: ACCOUNT_ANALYTICS_CODES.find(code => code === signal.code) ?? 'UNKNOWN'
          }),
      outcome: signal.outcome,
      account_result: signal.result,
      account_entity: signal.entity,
      account_day: signal.day,
      account_coverage: signal.coverage,
      item_count: signal.count,
      duration_ms: signal.durationMs
    });
  } catch {
    // Telemetry persistence is best effort; it never changes a committed action.
  }
}
