import { TeamFunctionError } from './errors.ts';
/** Code locations only: `at fn (file:line:col)` frames carry no request data. */
export function launchFailureFrames(error: unknown): string[] {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  return stack
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(line => /^at [\w$.<>\s[\]]*\(?(file|ext):[^\s)]+:\d+:\d+\)?$/u.test(line))
    .slice(0, 4)
    .map(line => line.replace(/^.*\/supabase\/functions\//u, 'at …/'));
}
function isSharedValidationError(error: unknown): error is Error & { reason: string } {
  if (!(error instanceof Error)) return false;
  const typed = error as Error & { code?: unknown; reason?: unknown };
  return (
    typed.code === 'INVALID_INPUT' &&
    typeof typed.reason === 'string' &&
    /^[a-z_]{1,40}$/u.test(typed.reason)
  );
}
/** Launch input/output can contain credentials. Unknown exception text is never logged or
 * returned; only the error class and code frames are logged, so a 500 is diagnosable. */
export function launchFailure(error: unknown): TeamFunctionError {
  if (error instanceof TeamFunctionError)
    return new TeamFunctionError(error.code, { status: error.status, retryable: error.retryable });
  // Shared validators (e.g. a deferred catalog link time already in the past) raise a typed,
  // content-free INVALID_INPUT. It is the caller's input, never an internal/uncertain failure.
  if (isSharedValidationError(error))
    return new TeamFunctionError('INVALID_INPUT', {
      retryable: false,
      details: { reason: error.reason }
    });
  console.error('[launch] internal error', {
    kind: error instanceof Error ? error.name : typeof error,
    frames: launchFailureFrames(error)
  });
  return new TeamFunctionError('LAUNCH_INTERNAL_ERROR', {
    retryable: true,
    details: { reason: 'UNKNOWN_CAUSE' }
  });
}
