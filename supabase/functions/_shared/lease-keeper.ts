/**
 * One failed lease renewal is not a lost lease. Under load a renewal answers
 * late or not at all (gateway 499, a 5xx, an isolate at its limit); the R2
 * copy workers used to abort the whole copy on the first such failure.
 *
 * The lease is lost only when the server says so (`renew` resolves to
 * anything but `true`), or when no renewal has succeeded for `stallMs`.
 * Server leases last 90 s from the moment a claim or renewal executes, and a
 * renewal only extends a lease that has not yet expired. Timing `stallMs` from
 * the START of the last successful request (or of the claim), which is no
 * later than the server's clock_timestamp(), stops this worker 30 s before
 * anyone else may claim the same row — time for the abort to reach the
 * in-flight Drive/R2 requests.
 */
export const LEASE_RENEW_INTERVAL_MS = 20_000;
/** A failed renewal is tried again this soon, not a full interval later. */
export const LEASE_RENEW_RETRY_MS = 5_000;
export const LEASE_STALL_MS = 60_000;

export interface LeaseKeeper {
  /** Stops renewing and waits for an in-flight renewal to settle. */
  stop(): Promise<void>;
}

export function keepLease(options: {
  renew: () => Promise<unknown>;
  onLost: () => void;
  /** When the claim that granted the lease was sent. */
  since: number;
  now?: () => number;
  intervalMs?: number;
  retryMs?: number;
  stallMs?: number;
}): LeaseKeeper {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? LEASE_RENEW_INTERVAL_MS;
  const retryMs = options.retryMs ?? LEASE_RENEW_RETRY_MS;
  const stallMs = options.stallMs ?? LEASE_STALL_MS;
  let closed = false;
  let next: ReturnType<typeof setTimeout> | null = null;
  let stall: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;

  const clear = () => {
    if (next) clearTimeout(next);
    if (stall) clearTimeout(stall);
    next = stall = null;
  };
  const lost = () => {
    if (closed) return;
    closed = true;
    clear();
    options.onLost();
  };
  const armStall = (validFrom: number) => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(lost, Math.max(0, validFrom + stallMs - now()));
  };
  const schedule = (delay: number) => {
    if (closed) return;
    if (next) clearTimeout(next);
    next = setTimeout(tick, delay);
  };
  function tick() {
    next = null;
    if (closed || inflight) return;
    const sentAt = now();
    inflight = options
      .renew()
      .then(
        value => {
          if (closed) return;
          if (value !== true) return lost();
          armStall(sentAt);
          schedule(intervalMs);
        },
        () => schedule(retryMs)
      )
      .finally(() => {
        inflight = null;
      });
  }

  armStall(options.since);
  schedule(intervalMs);
  return {
    async stop() {
      closed = true;
      clear();
      if (inflight) await inflight;
    }
  };
}
