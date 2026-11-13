import { captureAnalyticsActor, type AnalyticsActorSource } from '../../analytics/actorScope';
import { TEAM_ERROR_CODES, type TeamErrorCode } from '@video-compressor/shared';
const machineCauses = new Set<string>(TEAM_ERROR_CODES);
import { analytics } from '../../analytics/service';

export type CatalogUiAction =
  | 'list'
  | 'filter'
  | 'profile'
  | 'bulk'
  | 'template'
  | 'run'
  | 'retry'
  | 'stop'
  | 'restitch_claim'
  | 'publication'
  | 'video_create'
  | 'replace_video';
export type CatalogUiStage =
  | 'baseline_check_requested'
  | 'baseline_confirmed'
  | 'baseline_aborted'
  | 'executor_check_requested'
  | 'executor_checked'
  | 'claim_requested'
  | 'claim_idle'
  | 'claim_accepted'
  | 'claim_refused'
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
      | 'videoVariantCount'
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
    ...(['run', 'retry', 'stop', 'restitch_claim', 'publication', 'video_create'].includes(action)
      ? { production_completed: false }
      : {}),
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
    code?: CatalogUiFailure,
    operationId?: string
  ) {
    try {
      if (!ownsActor()) return;
      tracker.track(event, {
        ...base,
        action_identifier: stage,
        ...(operationId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          operationId
        )
          ? { run_id: operationId }
          : {}),
        ...(code ? { error_code: code } : {}),
        ...(code && machineCauses.has(code)
          ? {
              tool: 'team' as const,
              error_stage:
                action === 'restitch_claim' ? ('process' as const) : ('library' as const),
              error_fingerprint: `team:${action === 'restitch_claim' ? 'process' : 'library'}:${code}`
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
    /** A claim acknowledgement is never a produced or visibly delivered video. */
    claimResult(operationId: string | null) {
      if (settled || action !== 'restitch_claim') return;
      settled = true;
      emit(
        'operation_completed',
        operationId === null ? 'claim_idle' : 'claim_accepted',
        undefined,
        operationId ?? undefined
      );
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
