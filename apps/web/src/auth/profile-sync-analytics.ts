import { analytics, type ProductAnalytics } from '../analytics/service';
import type { AnalyticsProperties } from '../analytics/events';
import type { ProfileSyncCode } from '@video-compressor/shared';

/** State publication, not proof that every sibling received a message or painted the UI. */
export function observeProfileSync(
  actorId: string,
  action: 'refresh' | 'update',
  source: 'sibling' | 'focus' | 'visible' | 'form',
  tracker: Pick<ProductAnalytics, 'trackForActor'> = analytics
) {
  let attempt: string | undefined;
  try {
    attempt = crypto.randomUUID();
  } catch {
    /* Diagnostics cannot block a profile read. */
  }
  const started = Date.now();
  let terminal = false;
  const emit = (
    event: 'operation_started' | 'operation_completed' | 'operation_failed' | 'operation_cancelled',
    properties: AnalyticsProperties = {}
  ) => {
    if (!attempt) return;
    try {
      tracker.trackForActor(actorId, event, {
        flow_id: attempt,
        attempt_id: attempt,
        flow_step: `auth_profile_${action}`,
        source_kind: source,
        ...properties
      });
    } catch {
      /* Missing telemetry remains a coverage gap. */
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
    completed: () => finish('operation_completed', { outcome: 'success' }),
    superseded: () => finish('operation_cancelled', { outcome: 'cancelled' }),
    failed: (code: ProfileSyncCode) =>
      finish('operation_failed', {
        outcome: 'failure',
        error_category: 'profile_sync',
        error_stage: 'library',
        error_code: code,
        error_fingerprint: `auth:library:${code}`
      })
  };
}
