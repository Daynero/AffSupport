import { useCallback, useEffect, useRef, useState } from 'react';
import { isSoftReadFailure } from '../readCoordinator';

export const LAUNCH_PROGRESS_QUIET_MS = 45_000;
// A read that hangs (a paused gateway answers nothing) counts as an interruption after
// 10 s, so the calm note shows within a poll or two instead of ~24 s later (1.4.3).
export const LAUNCH_STATUS_READ_MS = 10_000;
export const LAUNCH_STATUS_POLL_MS = 10_000;
export const LAUNCH_CANCEL_STATUS_POLL_MS = 2_000;
/** After a transient read failure, read again sooner than the steady poll. */
export const LAUNCH_STATUS_RETRY_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
const STATUS_TIMEOUT = 'status-unconfirmed';

/** Reconcile automatically without overlapping reads or inventing progress. */
export function useLaunchProgressWatch(
  active: boolean,
  evidence: string,
  onRefresh?: (signal: AbortSignal) => Promise<void>,
  cancellationScope?: string
) {
  const callback = useRef(onRefresh);
  callback.current = onRefresh;
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  // A refusal or a malformed answer is not an outage: it must be shown at once.
  const [readFailedHard, setReadFailedHard] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const refresh = useCallback(async () => {
    if (!callback.current || inFlight.current) return;
    const version = epoch.current;
    const read = callback.current;
    const request = new AbortController();
    controller.current = request;
    inFlight.current = true;
    setChecking(true);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => read(request.signal)),
        new Promise<never>((_resolve, reject) => {
          readTimer.current = setTimeout(() => {
            request.abort();
            reject(new Error('status-unconfirmed'));
          }, LAUNCH_STATUS_READ_MS);
        })
      ]);
      if (version === epoch.current) {
        failures.current = 0;
        setReadFailed(false);
        setReadFailedHard(false);
      }
    } catch (error) {
      if (version === epoch.current) {
        const soft =
          isSoftReadFailure(error) || (error instanceof Error && error.message === STATUS_TIMEOUT);
        setReadFailed(true);
        if (!soft) setReadFailedHard(true);
        // Read again soon, backing off, so a short outage clears by itself.
        const delay =
          LAUNCH_STATUS_RETRY_MS[Math.min(failures.current, LAUNCH_STATUS_RETRY_MS.length - 1)];
        failures.current++;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (version === epoch.current && document.visibilityState !== 'hidden') void refresh();
        }, delay);
      }
    } finally {
      if (version === epoch.current) {
        if (readTimer.current) clearTimeout(readTimer.current);
        readTimer.current = null;
        inFlight.current = false;
        setChecking(false);
      }
    }
  }, []);
  // Cancellation is one exact generation: progress heartbeats must not keep
  // postponing its confirmation read or abort an already-running status read.
  const observationKey = cancellationScope ?? evidence;
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    inFlight.current = false;
    if (readTimer.current) clearTimeout(readTimer.current);
    setQuiet(false);
    setReadFailed(false);
    setReadFailedHard(false);
    failures.current = 0;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setChecking(false);
    const quietTimer = active
      ? setTimeout(() => {
          setQuiet(true);
        }, LAUNCH_PROGRESS_QUIET_MS)
      : null;
    const reconcile = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const poll = active
      ? setInterval(
          reconcile,
          cancellationScope ? LAUNCH_CANCEL_STATUS_POLL_MS : LAUNCH_STATUS_POLL_MS
        )
      : null;
    if (active && cancellationScope) reconcile();
    if (active) {
      window.addEventListener('online', reconcile);
      document.addEventListener('visibilitychange', reconcile);
    }
    return () => {
      epoch.current++;
      controller.current?.abort();
      if (quietTimer) clearTimeout(quietTimer);
      if (poll) clearInterval(poll);
      if (readTimer.current) clearTimeout(readTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      window.removeEventListener('online', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, [active, observationKey, cancellationScope, refresh]);
  return { quiet, checking, readFailed, readFailedHard, refresh };
}
