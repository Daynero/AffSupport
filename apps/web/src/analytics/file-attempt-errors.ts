import type { TeamAnalyticsOutcome } from '@video-compressor/shared';
import { isTeamFileAttemptCurrent, type TeamFileAttemptFlow } from './service';
import { trackToolError } from './errors';

function errorCodeOf(error: unknown) {
  return error instanceof Error ? error.message : 'PROCESS_FAILED';
}

/**
 * 031 FR-052 — `error_occurred` for a file action that failed, on the attempt's id. A cancel or
 * a question put to the person (a name clash, a permission they lack) is an outcome of the
 * attempt, not an error, and stays in `team_file_attempt_completed` alone.
 */
export function reportFileAttemptError(attempt: TeamFileAttemptFlow, error: unknown): void {
  if (!isTeamFileAttemptCurrent(attempt)) return;
  const outcome = analyticsOutcome(error);
  if (outcome !== 'failure' && outcome !== 'unsupported') return;
  trackToolError({
    tool: 'team',
    stage:
      attempt.action === 'upload'
        ? 'transfer'
        : attempt.action === 'download'
          ? 'download'
          : 'library',
    code: errorCodeOf(error),
    attemptId: attempt.attemptId,
    ...(attempt.flowId ? { flowId: attempt.flowId } : {}),
    retryable: retryableError(error)
  });
}

export function retryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return ['RATE_LIMITED', 'DRIVE_UNAVAILABLE', 'DELIVERY_UNAVAILABLE'].includes(errorCodeOf(error));
}

export function analyticsOutcome(error: unknown): TeamAnalyticsOutcome {
  const code = errorCodeOf(error);
  if (code === 'UNSUPPORTED_MEDIA' || code === 'TOO_LARGE') return 'unsupported';
  if (code === 'ABORTED' || code === 'CANCELED') return 'cancelled';
  if (
    [
      'AGENT_REQUIRED',
      'AGENT_UPDATE_REQUIRED',
      'NAME_CONFLICT',
      'NOT_A_MEMBER',
      'PERMISSION_DENIED',
      'ROOT_ESCAPE'
    ].includes(code)
  ) {
    return 'blocked';
  }
  return 'failure';
}
