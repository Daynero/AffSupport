import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
import type { AnalyticsEventName, AnalyticsProperties } from '../../analytics/events';

export type TaskDiagnosticStep =
  | 'task_create'
  | 'task_list'
  | 'task_read'
  | 'task_update'
  | 'task_editor_refresh'
  | 'task_editor_preserve_draft';
const replyFlows = new WeakMap<object, string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function signal(event: AnalyticsEventName, properties: AnalyticsProperties) {
  try {
    analytics.track(event, properties);
  } catch {
    // Diagnostics cannot change task delivery or access.
  }
}
/** Only opaque correlation IDs, closed steps and closed failure codes leave this seam. */
export function taskAttempt(step: TaskDiagnosticStep, flowId: string = crypto.randomUUID()) {
  const properties = {
    flow_id: UUID.test(flowId) ? flowId : crypto.randomUUID(),
    attempt_id: crypto.randomUUID(),
    flow_step: step
  };
  let owner: string | null | undefined;
  try {
    owner = analytics.journalContext?.()?.userId;
  } catch {
    /* Unavailable diagnostics stay silent. */
  }
  const emit = (event: AnalyticsEventName, properties: AnalyticsProperties) => {
    try {
      if (analytics.journalContext?.()?.userId !== owner) return;
      signal(event, properties);
    } catch {
      /* An identity change must not affect the task. */
    }
  };
  const started = Date.now();
  let ended = false;
  emit('operation_started', properties);
  return {
    properties,
    accepted() {
      if (!ended) emit('operation_stage_completed', properties);
    },
    finish(outcome: 'success' | 'failure' | 'cancelled', cause?: unknown) {
      if (ended) return;
      ended = true;
      const candidate = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      const code = TEAM_ERROR_CODES.find(value => value === candidate) ?? 'unknown';
      if (outcome === 'failure')
        emit('error_occurred', {
          ...properties,
          outcome,
          error_code: code,
          error_stage: 'library',
          error_fingerprint: `tasks:${step}:${code}`
        });
      emit(
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
/** Reply identity stays in RAM; task contents are never copied into telemetry. */
export function taskFlowFor(value: object): string {
  const known = replyFlows.get(value);
  if (known) return known;
  const id =
    'id' in value && typeof value.id === 'string' && UUID.test(value.id)
      ? value.id
      : crypto.randomUUID();
  replyFlows.set(value, id);
  return id;
}
export async function taskRpc<T>(
  step: Extract<TaskDiagnosticStep, 'task_create' | 'task_list' | 'task_read' | 'task_update'>,
  work: () => Promise<T>,
  flowId?: string
): Promise<T> {
  const attempt = taskAttempt(step, flowId);
  try {
    const result = await work();
    if (result && typeof result === 'object') {
      if (Array.isArray(result)) {
        for (const row of result) if (row && typeof row === 'object') taskFlowFor(row);
      } else {
        const task =
          'task' in result && result.task && typeof result.task === 'object' ? result.task : result;
        replyFlows.set(task, attempt.properties.flow_id);
      }
    }
    attempt.accepted();
    attempt.finish('success');
    return result;
  } catch (cause) {
    attempt.finish('failure', cause);
    throw cause;
  }
}
