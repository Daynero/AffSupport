import type { CatalogMaterialItem } from '@video-compressor/shared';
import { analytics, type ProductAnalytics } from '../../analytics/service';
import { trackToolError } from '../../analytics/errors';

export type PreviewAttemptOutcome = 'success' | 'failure' | 'unsupported' | 'cancelled';

export interface PreviewAttempt {
  readonly attemptId: string;
  /** Records the attempt's one terminal; any call after the first is ignored. */
  finish: (outcome: PreviewAttemptOutcome, errorCode?: unknown) => void;
}

/**
 * 033 FR-009 — one `team_preview_started` and exactly one `team_preview_completed` per opening
 * of a team material's preview, joined by an opaque `attempt_id`.
 *
 * The material's name, id and path never enter the events: only its category. A failure adds
 * one `error_occurred` on the same `attempt_id`, its code read by `safeErrorCode` — the team
 * event contract has no `error_code`, so that is where the code travels.
 */
export function startPreviewAttempt(
  category: CatalogMaterialItem['category'] | undefined,
  tracker: Pick<ProductAnalytics, 'track'> = analytics,
  now: () => number = () => Date.now()
): PreviewAttempt {
  const attemptId = crypto.randomUUID();
  const startedAt = now();
  const categoryProperty = category ? { category } : {};
  tracker.track('team_preview_started', {
    attempt_id: attemptId,
    stage: 'previewing',
    ...categoryProperty
  });
  let finished = false;
  return {
    attemptId,
    finish(outcome, errorCode) {
      if (finished) return;
      finished = true;
      tracker.track('team_preview_completed', {
        attempt_id: attemptId,
        stage: 'previewing',
        outcome,
        duration_ms: Math.max(0, now() - startedAt),
        ...categoryProperty
      });
      if (outcome === 'failure') {
        trackToolError({ tool: 'team', stage: 'library', code: errorCode, attemptId }, tracker);
      }
    }
  };
}
