import { knownTeamErrorCode, TeamFunctionError } from '../_shared/errors.ts';

/**
 * The error a failed database call of the catalog updater stands for.
 *
 * Production and beta, 2026-11-25: every refusal of a database function reached the
 * catalog manager and the logs as DRIVE_UNAVAILABLE — «Google Drive не відповідає» for a
 * picture pool that was not ready (GLOBAL_IMAGE_READINESS_UNKNOWN), a publication still on
 * its way, a lease someone else holds. A code the registry knows is passed on as it is; only
 * what is not one of ours (a connection that failed, a timeout, PostgREST's own errors)
 * stays the retryable DRIVE_UNAVAILABLE it always was.
 */
export function catalogUpdaterRpcError(
  name: string,
  failure: { code?: string; message?: string }
): TeamFunctionError {
  const code = knownTeamErrorCode(failure.message);
  if (code) return new TeamFunctionError(code);
  if (typeof failure.message === 'string' && /^[A-Z_]{2,64}$/u.test(failure.message))
    // A closed code the registry does not list yet: named in the log, retried as before.
    console.error('[catalog-updater] unregistered database code', name, failure.message);
  return new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
}
