import { WORKSPACE_READ_CODES } from '@video-compressor/shared';
import { analytics } from '../analytics/service';

/** One read owner per mounted scope. Signals during a read request one fresh follow-up. */
export function createReadCoordinator<T = void>(read: (signal: AbortSignal) => Promise<T>) {
  let pending: Promise<T | undefined> | null = null;
  let dirty = false;
  let stopped = false;
  let controller: AbortController | null = null;
  let started = 0;
  let confirmations: Array<{
    after: number;
    resolve: (value: T | undefined) => void;
    reject: (cause: unknown) => void;
  }> = [];
  const request = (): Promise<T | undefined> => {
    if (stopped) return Promise.resolve(undefined);
    dirty = true;
    if (pending) return pending;
    pending = (async () => {
      let failure: unknown;
      let result: T | undefined;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const readId = ++started;
          controller = new AbortController();
          let failed = false;
          try {
            result = await read(controller.signal);
            failure = undefined;
          } catch (error) {
            failure = error;
            failed = true;
          }
          const ready = confirmations.filter(waiter => waiter.after <= readId);
          confirmations = confirmations.filter(waiter => waiter.after > readId);
          for (const waiter of ready) {
            if (failed) waiter.reject(failure);
            else waiter.resolve(stopped ? undefined : result);
          }
        }
        if (failure !== undefined && !stopped) throw failure;
        return stopped ? undefined : result;
      } finally {
        pending = null;
        controller = null;
      }
    })();
    return pending;
  };
  return {
    isRunning: () => pending !== null,
    start() {
      stopped = false;
    },
    request,
    /** Confirm the first read begun after this call, without waiting for later signals. */
    requestFresh(): Promise<T | undefined> {
      if (stopped) return Promise.resolve(undefined);
      const confirmed = new Promise<T | undefined>((resolve, reject) => {
        confirmations.push({ after: started + 1, resolve, reject });
      });
      void request().catch(() => {});
      return confirmed;
    },
    hasFreshRequests: () => confirmations.some(waiter => waiter.after <= started),
    /** A same-scope mutation invalidated this read before it could paint. */
    deferFresh() {
      if (stopped) return;
      for (const waiter of confirmations) {
        if (waiter.after <= started) waiter.after = started + 1;
      }
      dirty = true;
    },
    stop() {
      stopped = true;
      dirty = false;
      for (const waiter of confirmations) waiter.resolve(undefined);
      confirmations = [];
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

const SOFT_READ_CODES = new Set<string>([
  'TEAM_TRANSPORT_UNAVAILABLE',
  'PROCESS_RESULT_UNCERTAIN',
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'INVALID_RESPONSE',
  ...WORKSPACE_READ_CODES
]);

/**
 * A progress read that failed because the server or the line to it did — a
 * 5xx, a timeout, a dropped connection, an aborted request, a body cut short —
 * rather than because the work did. On a run already known to be progressing
 * this says nothing about the run: the last good state stays on screen and the
 * poll goes on. A permission or other final code is never soft (1.4.3).
 */
export function isSoftReadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return SOFT_READ_CODES.has(code);
  if (error instanceof Error && SOFT_READ_CODES.has(error.message)) return true;
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  return (error as { name?: unknown }).name === 'AbortError';
}
