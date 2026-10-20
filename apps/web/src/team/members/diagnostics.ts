import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
import type { AnalyticsEventName, AnalyticsProperties } from '../../analytics/events';

export type MemberDiagnosticStep = 'members_list' | 'member_permissions_save' | 'member_remove';
export function memberSignal(event: AnalyticsEventName, properties: AnalyticsProperties): void {
  try {
    analytics.track(event, properties);
  } catch {
    /* Diagnostics cannot change access. */
  }
}

/** Opaque operation IDs only: never collect the target, identity, permission values or text. */
export function memberAttempt(flowStep: MemberDiagnosticStep, flowId: string) {
  const properties = { flow_id: flowId, attempt_id: crypto.randomUUID(), flow_step: flowStep };
  const started = Date.now();
  let ended = false;
  memberSignal('operation_started', properties);
  return {
    properties,
    accepted() {
      memberSignal('operation_stage_completed', properties);
    },
    finish(outcome: 'success' | 'failure' | 'cancelled', cause?: unknown) {
      if (ended) return;
      ended = true;
      const candidate = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      const code = TEAM_ERROR_CODES.find(value => value === candidate) ?? 'unknown';
      if (outcome === 'failure')
        memberSignal('error_occurred', {
          ...properties,
          outcome,
          error_code: code,
          error_stage: 'library',
          error_fingerprint: `members:${flowStep}:${code}`
        });
      memberSignal(
        outcome === 'success'
          ? 'operation_completed'
          : outcome === 'failure'
            ? 'operation_failed'
            : 'operation_cancelled',
        {
          ...properties,
          outcome,
          duration_ms: Math.max(0, Date.now() - started),
          ...(outcome === 'failure' ? { error_code: code } : {})
        }
      );
    }
  };
}
