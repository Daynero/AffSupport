import {
  LAUNCH_ANALYTICS_STAGES,
  safeLaunchAnalyticsCode,
  type LaunchGeneration,
  type LaunchAnalyticsAction,
  type LaunchAnalyticsField,
  type LaunchAnalyticsStage
} from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
type AnalyticsTracker = Pick<typeof analytics, 'track'>;
type Correlation = {
  flowId?: string;
  launchId?: string;
  generationId?: string;
  revisionId?: string;
};
function emit(record: () => void) {
  // Browser storage can reject analytics persistence (for example, quota
  // exhaustion). Telemetry must not turn a committed Launch action into a
  // user-visible failure or make its idempotent request look retryable.
  try {
    record();
  } catch {
    // Missing delivery is reported by coverage and diagnostic blind spots.
  }
}
function ids(c: Correlation) {
  return {
    flow_id: c.flowId,
    workflow_id: c.launchId,
    run_id: c.generationId,
    revision_id: c.revisionId
  };
}
export function launchIntent(
  c: Correlation,
  method: 'catalog' | 'other',
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('team_launch_intent', {
      ...ids(c),
      launch_action: 'generate',
      launch_method: method,
      launch_stage: 'validation'
    })
  );
}
export function launchAction(
  c: Correlation,
  action: LaunchAnalyticsAction,
  outcome: 'success' | 'failure' | 'cancelled' | 'blocked',
  code?: unknown,
  field?: LaunchAnalyticsField,
  tracker: AnalyticsTracker = analytics
) {
  emit(() =>
    tracker.track('team_launch_action', {
      ...ids(c),
      launch_action: action,
      outcome,
      ...(code === undefined ? {} : { launch_code: safeLaunchAnalyticsCode(code) }),
      launch_field: field
    })
  );
}
export function launchVisible(c: Correlation, tracker: AnalyticsTracker = analytics) {
  emit(() => tracker.track('team_launch_visible', { ...ids(c), outcome: 'success' }));
}
export function launchLocalStage(
  c: Correlation,
  stage: LaunchAnalyticsStage,
  tracker: AnalyticsTracker = analytics
) {
  emit(() => tracker.track('team_launch_stage', { ...ids(c), launch_stage: stage }));
}
/** Browser observation is separate from the authoritative DB terminal. */
export function launchObservedGeneration(
  c: Correlation,
  generation: LaunchGeneration,
  tracker: AnalyticsTracker = analytics
) {
  const stage = LAUNCH_ANALYTICS_STAGES.find(stage => stage === generation.stage);
  const terminal = ['succeeded', 'canceled', 'interrupted', 'partial', 'failed'].includes(
    generation.state
  );
  if (terminal)
    emit(() =>
      tracker.track('team_launch_terminal', {
        ...ids(c),
        launch_state: generation.state,
        launch_stage: stage,
        outcome:
          generation.state === 'succeeded'
            ? 'success'
            : generation.state === 'canceled'
              ? 'cancelled'
              : 'failure',
        ...(generation.errorCode
          ? { launch_code: safeLaunchAnalyticsCode(generation.errorCode) }
          : {})
      })
    );
  else
    emit(() =>
      tracker.track('team_launch_stage', {
        ...ids(c),
        launch_state: generation.state,
        launch_stage: stage
      })
    );
}

/** RPC acceptance is an action outcome; result visibility is proved separately. */
export async function launchMutation<T>(
  c: Correlation,
  action: LaunchAnalyticsAction,
  execute: () => Promise<T>,
  tracker: AnalyticsTracker = analytics
): Promise<T> {
  emit(() => tracker.track('team_launch_intent', { ...ids(c), launch_action: action }));
  try {
    const result = await execute();
    launchAction(c, action, 'success', undefined, undefined, tracker);
    return result;
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
    launchAction(c, action, 'failure', code, undefined, tracker);
    throw error;
  }
}
