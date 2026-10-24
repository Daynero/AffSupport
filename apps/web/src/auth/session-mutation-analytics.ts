import { analytics, type ProductAnalytics } from '../analytics/service';
import type { AnalyticsProperties } from '../analytics/events';
import { authSessionMutationCode } from './session-mutations';

/** SDK boundary only: never claim UI settlement, server retirement or key deletion. */
export function observeSessionLogout(
  actorId: string | undefined,
  tracker: Pick<ProductAnalytics, 'trackForActor'> = analytics
) {
  let attempt: string | undefined;
  try {
    if (actorId) attempt = crypto.randomUUID();
  } catch {
    /* Auth never depends on telemetry. */
  }
  const started = Date.now();
  let terminal = false,
    acquired = false;
  const emit = (
    event:
      | 'operation_started'
      | 'operation_stage_started'
      | 'operation_completed'
      | 'operation_failed'
      | 'operation_cancelled',
    properties: AnalyticsProperties = {}
  ) => {
    if (!actorId || !attempt) return;
    try {
      tracker.trackForActor(actorId, event, {
        flow_id: attempt,
        attempt_id: attempt,
        flow_step: 'auth_session_sdk_logout',
        ...properties
      });
    } catch {
      /* Missing diagnostics must not prevent session coordination. */
    }
  };
  const finish = (
    event: 'operation_completed' | 'operation_failed' | 'operation_cancelled',
    properties: AnalyticsProperties
  ) => {
    if (terminal) return;
    terminal = true;
    emit(event, { duration_ms: Math.max(0, Date.now() - started), ...properties });
  };
  emit('operation_started');
  return {
    acquired() {
      if (!terminal && !acquired) {
        acquired = true;
        emit('operation_stage_started');
      }
    },
    completed() {
      finish('operation_completed', { outcome: 'success' });
    },
    superseded() {
      finish('operation_cancelled', { outcome: 'cancelled' });
    },
    failed(error: unknown) {
      const code = authSessionMutationCode(error);
      finish('operation_failed', {
        outcome: 'failure',
        error_category: 'session_mutation',
        error_code: code,
        error_stage: 'library',
        error_fingerprint: `auth:library:${code}`
      });
    }
  };
}
