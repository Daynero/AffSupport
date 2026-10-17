export class LaunchPreparationError extends Error {
  constructor(readonly reason: 'canceled' | 'timeout') {
    super(reason);
  }
}

/** Only read-only preflight work belongs here. A late read must never start generation. */
export async function readLaunchPreparation<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void read.catch(() => {});
    throw new LaunchPreparationError('canceled');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    const value = await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new LaunchPreparationError('canceled'));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new LaunchPreparationError('timeout')), 15_000);
      })
    ]);
    if (signal.aborted) throw new LaunchPreparationError('canceled');
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
