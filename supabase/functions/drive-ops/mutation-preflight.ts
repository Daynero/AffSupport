import { mapUnknownError, TeamFunctionError } from '../_shared/errors.ts';
import type { OperationAuthority } from '../_shared/operations.ts';

/** Only metadata/access checks belong here, never provider writes or saga dispatch. */
export async function acceptMutationPreflight<T>(input: {
  accept: () => Promise<OperationAuthority>;
  preflight: () => Promise<T>;
  fail: (authority: OperationAuthority, error: TeamFunctionError) => Promise<void>;
}) {
  const authority = await input.accept();
  if (authority.reused && authority.state === 'succeeded') {
    // This is a historical operation receipt. A later restore, move or edit may
    // have changed the material; it is not a current-generation acknowledgement.
    // Never fabricate a file result or re-enter provider preflight to replay it.
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
  }
  try {
    const value = await input.preflight();
    return { authority, replayed: false as const, value };
  } catch (cause) {
    // The SQL failure sink must also atomically refuse if a same-key replay
    // advanced this operation while these metadata checks were awaiting.
    if (!authority.reused)
      await input.fail(authority, mapUnknownError(cause)).catch(() => undefined);
    throw cause;
  }
}
