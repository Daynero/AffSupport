import { WORKSPACE_READ_CODES } from '@video-compressor/shared';
import { analytics } from '../analytics/service';

/** One read owner per mounted scope. Signals during a read request one fresh follow-up. */
export function createReadCoordinator(read: (signal: AbortSignal) => Promise<void>) {
  let pending: Promise<void> | null = null;
  let dirty = false;
  let stopped = false;
  let controller: AbortController | null = null;
  return {
    isRunning: () => pending !== null,
    start() {
      stopped = false;
    },
    request(): Promise<void> {
      if (stopped) return Promise.resolve();
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        let failure: unknown;
        try {
          while (dirty && !stopped) {
            dirty = false;
            controller = new AbortController();
            try {
              await read(controller.signal);
              failure = undefined;
            } catch (error) {
              failure = error;
            }
          }
          if (failure !== undefined && !stopped) throw failure;
        } finally {
          pending = null;
          controller = null;
        }
      })();
      return pending;
    },
    stop() {
      stopped = true;
      dirty = false;
      controller?.abort();
    }
  };
}

/** Bounds token acquisition as well as HTTP; a late transport result cannot win. */
export function withReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  milliseconds = 15_000
): Promise<T> {
  const controller = new AbortController();
  let actor: string | null | undefined;
  try {
    actor = analytics.journalContext?.()?.userId;
  } catch {
    /* optional diagnostics */
  }
  let timer: ReturnType<typeof setTimeout>;
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new DOMException('Read cancelled', 'AbortError'));
    };
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const code = WORKSPACE_READ_CODES[0];
      try {
        if (analytics.journalContext?.()?.userId === actor)
          analytics.track('error_occurred', {
            error_code: code,
            error_stage: 'library',
            error_fingerprint: `team:read:${code}`
          });
      } catch {
        /* Diagnostics cannot change read settlement. */
      }
      reject(Object.assign(new Error(code), { code }));
    }, milliseconds);
  });
  return Promise.race([
    parent.aborted
      ? cancelled
      : Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
          return read(controller.signal);
        }),
    cancelled,
    deadline
  ]).finally(() => {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
  });
}
