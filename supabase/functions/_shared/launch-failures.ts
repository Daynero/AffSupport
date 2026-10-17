import { TeamFunctionError } from './errors.ts';
/** Launch input/output can contain credentials. Unknown exception text is never logged or returned. */
export function launchFailure(error: unknown): TeamFunctionError {
  return error instanceof TeamFunctionError
    ? new TeamFunctionError(error.code, { status: error.status, retryable: error.retryable })
    : new TeamFunctionError('LAUNCH_INTERNAL_ERROR', {
        retryable: true,
        details: { reason: 'UNKNOWN_CAUSE' }
      });
}
