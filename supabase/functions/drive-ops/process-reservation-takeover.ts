import { TeamFunctionError } from '../_shared/errors.ts';

/** The key the explorer queue and the process dialog send: `crypto.randomUUID()`, nothing else. */
const MANUAL_RUN_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Starts a process operation; when its output name is held by the same person's unfinished run
 * of the same file (production 2026-11-26: the run failed on the computer and the page's cancel
 * was lost with the network), that run is cancelled and the start is tried once more.
 *
 * Which runs may be taken over is decided by the database
 * (`service_release_own_process_reservation`): a manual run of the same actor, source,
 * destination and name that has not started writing to Drive. Anything else keeps the conflict.
 */
export async function startProcessTakingOverOwnRun<T>(input: {
  start: () => Promise<T>;
  release: () => Promise<unknown>;
  idempotencyKey: string;
  reservedNameKey: string | null;
  trusted: boolean;
}): Promise<T> {
  try {
    return await input.start();
  } catch (error) {
    if (
      !(error instanceof TeamFunctionError) ||
      error.code !== 'NAME_CONFLICT' ||
      input.trusted ||
      !input.reservedNameKey ||
      !MANUAL_RUN_KEY.test(input.idempotencyKey)
    )
      throw error;
    const released = await input.release();
    if (typeof released !== 'string') throw error;
    return await input.start();
  }
}
