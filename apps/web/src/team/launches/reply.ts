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
