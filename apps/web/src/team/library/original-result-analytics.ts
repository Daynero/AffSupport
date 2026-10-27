import type { LibraryVideoTextVariant } from '@video-compressor/shared';
import { analytics } from '../../analytics/service';
import { analyticsRunId } from '../../analytics/tools';

/** A displayed/copied original is distinct from a registered file. Legacy provenance stays unknown. */
export function recordOriginalResultDelivery(
  variant: LibraryVideoTextVariant,
  action: 'visible' | 'copied'
): void {
  const attemptId = analyticsRunId(variant.attemptId);
  if (
    !attemptId ||
    variant.kind !== 'original' ||
    variant.ingestState !== 'full' ||
    variant.truncated ||
    !variant.text
  )
    return;
  analytics.track(action === 'visible' ? 'result_opened' : 'operation_stage_completed', {
    tool_identifier: 'transcription',
    flow_step: 'library_original_processing',
    action_identifier: action,
    attempt_id: attemptId,
    outcome: 'success'
  });
}
