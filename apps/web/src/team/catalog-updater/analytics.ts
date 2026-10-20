import { analytics } from '../../analytics/service';

export type CatalogUiAction = 'list' | 'filter' | 'profile' | 'bulk' | 'template';
export type CatalogUiStage =
  | 'opened'
  | 'draft_changed'
  | 'save_requested'
  | 'save_confirmed'
  | 'conflict'
  | 'result_visible'
  | 'stale'
  | 'readback_requested'
  | 'undo_requested';
export type CatalogUiFailure =
  'READ_FAILED' | 'SAVE_FAILED' | 'CONFLICT' | 'VALIDATION' | 'UNKNOWN';
type Tracker = Pick<typeof analytics, 'track'>;

/** No names, search terms, paths, settings values or provider errors enter this seam. */
export function beginCatalogUiFlow(
  action: CatalogUiAction,
  counts: {
    count?: number;
    hiddenCount?: number;
    parentFlowId?: string;
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
  let settled = false;
  const base = {
    flow_id: counts.parentFlowId ?? id,
    attempt_id: id,
    feature_identifier: 'catalog_manager',
    flow_step: `catalog_manager_${action}`,
    item_count: counts.count,
    file_count: counts.hiddenCount,
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
      tracker.track(event, {
        ...base,
        action_identifier: stage,
        ...(code ? { error_code: code } : {}),
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
    } catch {
      // Telemetry never changes the outcome of a saved operation.
    }
  }
  emit('operation_started', 'opened');
  return {
    id,
    stage(stage: CatalogUiStage) {
      if (!settled) emit('operation_stage_completed', stage);
    },
    /** Call only after the confirmed result has committed to the visible UI. */
    complete() {
      if (settled) return;
      settled = true;
      emit('operation_completed', 'result_visible');
    },
    fail(code: CatalogUiFailure) {
      if (settled) return;
      settled = true;
      emit('operation_failed', code === 'CONFLICT' ? 'conflict' : 'save_requested', code);
    },
    cancel() {
      if (settled) return;
      settled = true;
      emit('operation_cancelled', 'opened');
    }
  };
}
export type CatalogUiFlow = ReturnType<typeof beginCatalogUiFlow>;
