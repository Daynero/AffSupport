import type { TeamErrorCode } from '@video-compressor/shared';
import { teamErrorCodeOf } from '../errors';
import { analytics } from '../../analytics/service';
import { captureAnalyticsActor } from '../../analytics/actorScope';
export type WorkspaceAction =
  'task_copy' | 'task_detach' | 'task_cleanup' | 'bulk_trash' | 'restore';
export type WorkspaceDiagnosticSource =
  | 'trash_refresh'
  | 'trash_prepare'
  | 'trash_mark_request'
  | 'trash_request'
  | 'trash_reconcile'
  | 'trash_overlap'
  | 'trash_start'
  | 'restore_request';
export type WorkspaceStage =
  | 'requested'
  | 'accepted'
  | 'running'
  | 'confirmed'
  | 'partial'
  | 'unknown'
  | 'rejected'
  | 'result_visible';
/** Closed vocabulary and opaque correlation only. Server commit and UI delivery remain separate evidence. */
export function beginWorkspaceOperation(
  action: WorkspaceAction,
  flowId: string,
  count: number,
  tracker = analytics,
  observing = false
) {
  const ownsActor = captureAnalyticsActor(tracker);
  const attemptId = crypto.randomUUID();
  const base = {
    flow_id: flowId,
    attempt_id: attemptId,
    feature_identifier: 'workspace_ux',
    flow_step: `workspace_${action}`,
    item_count: Math.min(500, Math.max(0, count))
  };
  let settled = false;
  let receiptId: string | undefined;
  const send = (
    event:
      | 'operation_started'
      | 'operation_stage_completed'
      | 'operation_completed'
      | 'operation_failed',
    stage: WorkspaceStage,
    error?: TeamErrorCode | 'UNKNOWN'
  ) => {
    try {
      if (!ownsActor()) return;
      tracker.track(event, {
        ...base,
        ...(receiptId ? { run_id: receiptId } : {}),
        action_identifier: stage,
        ...(error ? { error_code: error } : {})
      });
    } catch {
      /* Diagnostics cannot change a file operation. */
    }
  };
  send(
    observing ? 'operation_stage_completed' : 'operation_started',
    observing ? 'accepted' : 'requested'
  );
  const visibleResult = (
    outcome: 'success' | 'failure' | 'unknown',
    code?: TeamErrorCode | 'UNKNOWN'
  ) => {
    if (settled || !ownsActor()) return;
    if (outcome === 'unknown') {
      send('operation_stage_completed', 'result_visible', code);
      return;
    }
    settled = true;
    send(
      outcome === 'success' ? 'operation_completed' : 'operation_failed',
      'result_visible',
      code
    );
  };
  return {
    visibleResult,
    diagnostic(source: WorkspaceDiagnosticSource, cause: unknown) {
      if (settled || !ownsActor()) return;
      try {
        tracker.track('operation_stage_completed', {
          ...base,
          source_kind: source,
          error_fingerprint: 'workspace:receipt',
          action_identifier: 'diagnostic',
          error_code: teamErrorCodeOf(cause) ?? 'UNKNOWN'
        });
      } catch {
        /* Diagnostics cannot change a file operation. */
      }
    },
    receipt(id: string) {
      if (!settled && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
        receiptId = id;
        send('operation_stage_completed', 'accepted');
      }
    },
    stage(stage: WorkspaceStage, code?: TeamErrorCode) {
      if (!settled) send('operation_stage_completed', stage, code);
    },
    visible() {
      visibleResult('success');
    },
    fail(cause?: unknown) {
      if (settled) return;
      const code = teamErrorCodeOf(cause) ?? 'UNKNOWN';
      if (['PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_INPUT', 'WRONG_STATE'].includes(code)) {
        settled = true;
        send('operation_failed', 'rejected', code);
      } else send('operation_stage_completed', 'unknown', code);
    }
  };
}
export type WorkspaceOperationFlow = ReturnType<typeof beginWorkspaceOperation>;
