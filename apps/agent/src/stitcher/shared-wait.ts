/** A consumer can leave shared work without canceling its producer. */
export function waitForShared<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('STITCH_CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('STITCH_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
