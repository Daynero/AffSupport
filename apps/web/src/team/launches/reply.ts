import { TeamApiError } from '../../api/team';

export const LAUNCH_REPLY_DEADLINE_MS = 30_000;
/** A lost mutation reply is uncertain, never proof of rejection; callers retain their keys. */
export async function launchReply<T>(reply: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reply,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true)),
          LAUNCH_REPLY_DEADLINE_MS
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop waiting for an obsolete UI execution without canceling its authorized native work. */
export async function whileLaunchActive<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        stop = () => reject(new Error('superseded-launch-wait'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      })
    ]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * A generate the server refused only because Google was briefly unavailable is sent again
 * with the same request key (the server admits a key once, so a repeat never duplicates):
 * production 2026-11-12, a launch's source check met one unanswered Drive call and the person
 * saw «Помилка — перевірте стан… Операція може ще виконуватися» for a launch nothing had
 * started. Only these proved, transient refusals are repeated; anything else is shown.
 */
export const LAUNCH_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000];
const LAUNCH_TRANSIENT_CODES: ReadonlySet<string> = new Set(['DRIVE_UNAVAILABLE', 'RATE_LIMITED']);

export async function withLaunchTransientRetry<T>(
  send: () => Promise<T>,
  options: {
    /** Throws when the person canceled or the request is no longer theirs. */
    stillWanted: () => void;
    signal: AbortSignal;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  }
): Promise<T> {
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) => {
      let timer: ReturnType<typeof setTimeout>;
      return whileLaunchActive(
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, ms);
        }),
        signal
      ).finally(() => clearTimeout(timer));
    });
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (
        attempt >= LAUNCH_TRANSIENT_RETRY_DELAYS_MS.length ||
        !(error instanceof TeamApiError) ||
        !LAUNCH_TRANSIENT_CODES.has(error.code)
      )
        throw error;
      await sleep(LAUNCH_TRANSIENT_RETRY_DELAYS_MS[attempt]!, options.signal);
      options.stillWanted();
    }
  }
}
