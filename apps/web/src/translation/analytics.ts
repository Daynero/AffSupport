/**
 * What transcript translation tells the analytics pipeline (063). Codes, languages and sizes only —
 * never the transcript or the translation.
 */
import { analytics } from '../analytics/service';
import { analyticsRunId } from '../analytics/tools';

export type TranslationAction =
  | 'requested'
  | 'started'
  | 'reused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'opened'
  | 'copied';

export function trackTranslation(input: {
  action: TranslationAction;
  scope: 'team_video' | 'personal';
  targetLanguage: string;
  translationId?: string | null;
  units?: number;
  code?: string | null;
  durationMs?: number;
}): void {
  const attemptId = analyticsRunId(input.translationId ?? null);
  const failed = input.action === 'failed' || input.action === 'blocked';
  analytics.track(
    input.action === 'opened'
      ? 'result_opened'
      : input.action === 'failed'
        ? 'operation_failed'
        : input.action === 'completed'
          ? 'operation_completed'
          : input.action === 'started'
            ? 'operation_started'
            : 'operation_stage_completed',
    {
      tool_identifier: 'transcription',
      flow_step: 'transcript_translation',
      action_identifier: input.action,
      source_kind: input.scope,
      setting_name: 'target_language',
      setting_value: input.targetLanguage,
      outcome: failed ? 'failure' : 'success',
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(input.units !== undefined ? { item_count: input.units } : {}),
      ...(input.code ? { error_code: input.code } : {}),
      ...(input.durationMs !== undefined ? { processing_duration_ms: input.durationMs } : {})
    }
  );
}
