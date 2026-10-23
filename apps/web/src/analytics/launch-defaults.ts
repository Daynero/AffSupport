import { safeLaunchAnalyticsCode } from '@video-compressor/shared';
import { analytics } from './service';

export type DefaultsScope = 'offer' | 'workspace';
/** Only closed discriminators and opaque request IDs; never names or profile values. */
export function observeLaunchDefaults(
  action: 'read' | 'save' | 'apply',
  scope: DefaultsScope,
  flowId: string = crypto.randomUUID()
) {
  const properties = {
    flow_id: flowId,
    attempt_id: crypto.randomUUID(),
    flow_step: `launch_defaults_${action}_${scope}`
  };
  const emit: typeof analytics.track = (name, values) => {
    try {
      analytics.track(name, values);
    } catch {
      /* Diagnostics must not break settings. */
    }
  };
  let finished = false;
  emit('operation_started', properties);
  return {
    finish(outcome: 'success' | 'failure' | 'cancelled', error?: unknown) {
      if (finished) return;
      finished = true;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
      emit(
        outcome === 'success'
          ? 'operation_completed'
          : outcome === 'cancelled'
            ? 'operation_cancelled'
            : 'operation_failed',
        {
          ...properties,
          outcome,
          ...(outcome === 'failure' ? { error_code: safeLaunchAnalyticsCode(code) } : {})
        }
      );
    }
  };
}
