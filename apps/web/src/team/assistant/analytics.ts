import { safeLaunchAnalyticsCode } from '@video-compressor/shared';
import { analytics } from '../../analytics/service';

export type AssistantStep = 'send' | 'launch' | 'open';

/**
 * 064: the browser's part of the assistant trail — that a message was sent, that «Запустити N»
 * handed rows to the batch, that the panel opened. Only a closed step, opaque ids and a code;
 * never the message, names, links or counts tied to content. The server's command row is the
 * authority for what happened next.
 */
export function observeAssistant(step: AssistantStep, _context: Record<string, unknown> = {}) {
  const properties = {
    flow_id: crypto.randomUUID(),
    attempt_id: crypto.randomUUID(),
    flow_step: `launch_assistant_${step}`
  };
  const emit: typeof analytics.track = (name, values) => {
    try {
      analytics.track(name, values);
    } catch {
      /* Diagnostics must not break the assistant. */
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
