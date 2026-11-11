/**
 * One heartbeat that fails in transport is not a lost lease. Under load the
 * backend answers a heartbeat late or not at all (gateway 499, an edge isolate
 * at its CPU/wall limit, a 5xx, a rate limit); 1.4.2 stopped the whole stitch
 * on the first such failure and left its operation running for the server to
 * guess about (beta 2026-11-11, set a0f1fd63).
 *
 * A run now stops only when the server says so with a definitive answer, or
 * when no heartbeat has succeeded for `stallMs`. The server takes a silent
 * variant over after two minutes and a recovery lease lasts two minutes, so
 * 90 s — measured from the START of the last successful heartbeat, which is no
 * later than the moment the server recorded it — always stops this executor
 * before anyone else may start writing the same output.
 */
export const HEARTBEAT_STALL_MS = 90_000;
/** A failed heartbeat is tried again this soon, not a full interval later. */
export const HEARTBEAT_RETRY_MS = 10_000;

const DEFINITIVE = new Set([
  'PERMISSION_DENIED',
  'AGENT_UPDATE_REQUIRED',
  'WRONG_STATE',
  'REQUEST_REUSE_CONFLICT',
  'SOURCE_CHANGED',
  'INVALID_INPUT',
  'PROCESS_CANCELED',
  'LEASE_MISMATCH',
  'LEASE_EXPIRED',
  'NOT_FOUND',
  'REVOKED'
]);

/** Whether a heartbeat error is the server refusing this executor for good,
 * as opposed to a transport or capacity failure worth retrying. */
export function isDefinitiveHeartbeatRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return DEFINITIVE.has(typeof code === 'string' ? code : error.message);
}

/**
 * Fires `onStall` once no heartbeat has succeeded for `stallMs`, however long
 * the failing requests themselves hang. `alive(startedAt)` records a success,
 * timed from when that heartbeat request was sent.
 */
export function heartbeatWatchdog(options: {
  onStall: () => void;
  stallMs?: number;
  now?: () => number;
}) {
  const stallMs = options.stallMs ?? HEARTBEAT_STALL_MS;
  const now = options.now ?? Date.now;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        if (!closed) options.onStall();
      },
      Math.max(0, delay)
    );
    timer.unref?.();
  };
  arm(stallMs);
  return {
    alive(startedAt: number) {
      if (!closed) arm(startedAt + stallMs - now());
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/** Waits between attempts of an idempotent server call that failed in transport. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 10_000];

/**
 * Repeats an idempotent server call while it fails transiently, for at most
 * `budgetMs` from its first failure. The same 90 s as the heartbeat watchdog:
 * by then the run stops on its own, so a retry never outlives the executor's
 * right to act. Only a call whose repeat cannot spend or grant twice may go
 * through here (persisted request ids, exact readback, the same closure nonce).
 */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  options: {
    transient: (error: unknown) => boolean;
    signal?: AbortSignal;
    budgetMs?: number;
    delaysMs?: readonly number[];
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }
): Promise<T> {
  const budget = options.budgetMs ?? HEARTBEAT_STALL_MS;
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        timer.unref?.();
        function done() {
          signal?.removeEventListener('abort', done);
          clearTimeout(timer);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      }));
  let firstFailure: number | null = null;
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (options.signal?.aborted || !options.transient(error)) throw error;
      firstFailure ??= now();
      const wait = delays[Math.min(index, delays.length - 1)] ?? 0;
      if (now() + wait - firstFailure > budget) throw error;
      await sleep(wait, options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
}
