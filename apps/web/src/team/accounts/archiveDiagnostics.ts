import { analytics } from '../../analytics/service';
import type { TeamAccountArchiveReason } from '@video-compressor/shared';

export type ArchiveAction = 'archive' | 'restore';

export function trackAccountArchiveStart(requestId: string, action: ArchiveAction): number {
  const startedAt = Date.now();
  analytics.track('team_workflow_started', {
    workflow_id: requestId,
    action,
    category: 'other',
    cache_state: 'unknown',
    attempt_number: 1,
    stage: 'processing'
  });
  return startedAt;
}

function reasonFor(error: unknown): TeamAccountArchiveReason {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'ACTIVE_LAUNCH') return 'active_launch';
  if (code === 'PERMISSION_DENIED') return 'permission_denied';
  return 'unknown';
}

export function trackAccountArchiveEnd(
  requestId: string,
  action: ArchiveAction,
  startedAt: number,
  result: 'applied' | 'conflict' | unknown
): void {
  const applied = result === 'applied';
  const conflict = result === 'conflict';
  const archiveReason: TeamAccountArchiveReason | undefined = applied
    ? undefined
    : conflict
      ? 'conflict'
      : reasonFor(result);
  analytics.track('team_workflow_completed', {
    workflow_id: requestId,
    action,
    category: 'other',
    cache_state: 'unknown',
    attempt_number: 1,
    stage: 'finalizing',
    duration_ms: Date.now() - startedAt,
    outcome: applied ? 'success' : conflict || archiveReason !== 'unknown' ? 'blocked' : 'failure',
    ...(archiveReason ? { archive_reason: archiveReason } : {}),
    retryable: conflict || archiveReason === 'unknown',
    production_completed: applied
  });
}
