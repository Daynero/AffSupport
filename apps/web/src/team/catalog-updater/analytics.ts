import { captureAnalyticsActor, type AnalyticsActorSource } from '../../analytics/actorScope';
import { TEAM_ERROR_CODES, type TeamErrorCode } from '@video-compressor/shared';
const machineCauses = new Set<string>(TEAM_ERROR_CODES);
import { analytics } from '../../analytics/service';

export type CatalogUiAction =
  'list' | 'filter' | 'profile' | 'bulk' | 'template' | 'run' | 'retry' | 'stop';
export type CatalogUiStage =
  | 'opened'
  | 'draft_changed'
  | 'save_requested'
  | 'save_confirmed'
  | 'conflict'
  | 'result_visible'
  | 'stale'
  | 'readback_requested'
  | 'undo_requested'
  | 'command_requested'
  | 'command_accepted'
  | 'command_cancel_requested'
  | 'command_cancelled'
  | 'stop_requested'
  | 'stop_accepted'
  | 'stop_not_active'
  | 'stop_reply_unknown'
  | 'stop_rejected'
  | 'stop_check_requested'
  | 'stop_readback_requested'
  | 'stop_target_inactive'
  | 'stop_target_active'
  | 'stop_readback_unknown';
export type CatalogUiFailure =
  'READ_FAILED' | 'SAVE_FAILED' | 'CONFLICT' | 'VALIDATION' | 'UNKNOWN' | TeamErrorCode;
type Tracker = Pick<typeof analytics, 'track'> & AnalyticsActorSource;

/** No names, search terms, paths, settings values or provider errors enter this seam. */
export function beginCatalogUiFlow(
  action: CatalogUiAction,
  counts: {
    count?: number;
    hiddenCount?: number;
    parentFlowId?: string;
    relatedFlowId?: string;
    originFlowId?: string;
    field?:
      | 'createdAt'
      | 'restitch'
      | 'randomLinkVariation'
      | 'refreshImages'
      | 'refreshTexts'
      | 'growProducts'
      | 'updateInterval';
  } = {},
  tracker: Tracker = analytics
) {
  const id = crypto.randomUUID();
  const startedAt = performance.now();
  const ownsActor = captureAnalyticsActor(tracker);
  let settled = false;
  const base = {
    flow_id: counts.parentFlowId ?? id,
    attempt_id: id,
    ...(counts.relatedFlowId ? { parent_flow_id: counts.relatedFlowId } : {}),
    ...(counts.originFlowId ? { workflow_id: counts.originFlowId } : {}),
    feature_identifier: 'catalog_manager',
    flow_step: `catalog_manager_${action}`,
    item_count: counts.count,
    file_count: counts.hiddenCount,
    ...(['run', 'retry', 'stop'].includes(action) ? { production_completed: false } : {}),
    ...(counts.field ? { setting_name: counts.field } : {})
  };
  function emit(
    event:
      | 'operation_started'
      | 'operation_stage_completed'
      | 'operation_completed'
      | 'operation_failed'
      | 'operation_cancelled',
    stage: CatalogUiStage,
    code?: CatalogUiFailure
  ) {
    try {
      if (!ownsActor()) return;
      tracker.track(event, {
        ...base,
        action_identifier: stage,
        ...(code ? { error_code: code } : {}),
        ...(code && machineCauses.has(code)
          ? {
              tool: 'team' as const,
              error_stage: 'library' as const,
              error_fingerprint: `team:library:${code}`
            }
          : {}),
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
    } catch {
      // Telemetry never changes the outcome of a saved operation.
    }
  }
  emit('operation_started', 'opened');
  return {
    id,
    stage(stage: CatalogUiStage, code?: CatalogUiFailure) {
      if (!settled) emit('operation_stage_completed', stage, code);
    },
    /** Call only after the confirmed result has committed to the visible UI. */
    complete() {
      if (settled) return;
      settled = true;
      emit('operation_completed', 'result_visible');
    },
    fail(code: CatalogUiFailure, stage?: CatalogUiStage) {
      if (settled) return;
      settled = true;
      emit(
        'operation_failed',
        stage ??
          (code === 'CONFLICT'
            ? 'conflict'
            : action === 'stop'
              ? 'stop_requested'
              : ['run', 'retry'].includes(action)
                ? 'command_requested'
                : 'save_requested'),
        code
      );
    },
    cancel() {
      if (settled) return;
      settled = true;
      emit('operation_cancelled', 'opened');
    }
  };
}
export type CatalogUiFlow = ReturnType<typeof beginCatalogUiFlow>;
