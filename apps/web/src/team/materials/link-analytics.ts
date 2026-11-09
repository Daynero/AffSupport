import { analytics } from '../../analytics/service';
import { captureAnalyticsActor } from '../../analytics/actorScope';
import { TEAM_ERROR_CODES, type TeamErrorCode } from '@video-compressor/shared';
const causes = new Set<string>(TEAM_ERROR_CODES);
export type MaterialLinkAction = 'get_link' | 'share' | 'confirm' | 'readback' | 'clipboard';
export type MaterialLinkStage =
  | 'requested'
  | 'url_verified'
  | 'visibility_verified'
  | 'visibility_unknown'
  | 'confirmation_required'
  | 'permission_requested'
  | 'permission_verified'
  | 'permission_unknown'
  | 'preference_saved'
  | 'preference_failed'
  | 'preference_checked'
  | 'preference_unknown'
  | 'url_visible'
  | 'clipboard_copied'
  | 'clipboard_denied';

/** Closed observations only: never URLs, material names, paths or provider payloads. */
export function beginMaterialLinkFlow(
  action: MaterialLinkAction,
  input: { commandId?: string; attemptId?: string; parentFlowId?: string } = {}
) {
  const attemptId = input.attemptId ?? crypto.randomUUID();
  const commandId = input.commandId ?? attemptId;
  const ownsActor = captureAnalyticsActor(analytics);
  const start = performance.now();
  let ended = false;
  let parentFlowId = input.parentFlowId;
  const emit = (
    event:
      | 'operation_started'
      | 'operation_stage_completed'
      | 'operation_completed'
      | 'operation_failed'
      | 'operation_cancelled',
    stage: MaterialLinkStage,
    productionCompleted = false,
    code?: TeamErrorCode
  ) => {
    if (!ownsActor()) return;
    try {
      analytics.track(event, {
        flow_id: commandId,
        ...(parentFlowId ? { parent_flow_id: parentFlowId } : {}),
        attempt_id: attemptId,
        feature_identifier: 'material_link',
        flow_step: `material_link_${action}`,
        action_identifier: stage,
        production_completed: productionCompleted,
        duration_ms: Math.max(0, Math.round(performance.now() - start)),
        ...(code ? { error_code: code } : {}),
        ...(code && causes.has(code)
          ? { tool: 'team', error_stage: 'library', error_fingerprint: `team:library:${code}` }
          : {})
      });
    } catch {
      /* Diagnostics never prevent link delivery or clipboard recovery. */
    }
  };
  emit('operation_started', 'requested');
  return {
    commandId,
    attemptId,
    relateParent(id: string) {
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) &&
        id !== commandId
      )
        parentFlowId = id;
    },
    stage(stage: MaterialLinkStage, code?: TeamErrorCode) {
      if (!ended) emit('operation_stage_completed', stage, false, code);
    },
    complete(goalReached: boolean) {
      if (ended) return;
      ended = true;
      emit(
        'operation_completed',
        action === 'clipboard' ? 'clipboard_copied' : 'url_visible',
        goalReached
      );
    },
    fail(code: TeamErrorCode, stage: MaterialLinkStage) {
      if (ended) return;
      ended = true;
      emit('operation_failed', stage, false, code);
    },
    cancel() {
      if (ended) return;
      ended = true;
      emit('operation_cancelled', 'requested');
    }
  };
}
export type MaterialLinkFlow = ReturnType<typeof beginMaterialLinkFlow>;
