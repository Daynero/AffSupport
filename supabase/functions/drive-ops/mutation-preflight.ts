import { mapUnknownError, type TeamFunctionError } from '../_shared/errors.ts';
import type { OperationAuthority } from '../_shared/operations.ts';

/** Only metadata/access checks belong here, never provider writes or saga dispatch. */
export async function acceptMutationPreflight<T>(input: {
  accept: () => Promise<OperationAuthority>;
  preflight: () => Promise<T>;
  fail: (authority: OperationAuthority, error: TeamFunctionError) => Promise<void>;
}) {
  const authority = await input.accept();
  if (authority.reused && authority.state === 'succeeded')
    return { authority, replayed: true as const };
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
