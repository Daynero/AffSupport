import { useCallback, useEffect, useRef, useState } from 'react';

export const LAUNCH_PROGRESS_QUIET_MS = 45_000;
export const LAUNCH_STATUS_READ_MS = 15_000;

/** A quiet operation is not a failed operation. Reconcile once, then offer an explicit read. */
export function useLaunchProgressWatch(
  active: boolean,
  evidence: string,
  onRefresh?: (signal: AbortSignal) => Promise<void>
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
  const refresh = useCallback(async () => {
    if (!callback.current || inFlight.current) return;
    const version = epoch.current;
    const read = callback.current;
    const request = new AbortController();
    controller.current = request;
    inFlight.current = true;
    setChecking(true);
    setReadFailed(false);
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
    } catch {
      if (version === epoch.current) setReadFailed(true);
    } finally {
      if (version === epoch.current) {
        if (readTimer.current) clearTimeout(readTimer.current);
        readTimer.current = null;
        inFlight.current = false;
        setChecking(false);
      }
    }
  }, []);
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    inFlight.current = false;
    if (readTimer.current) clearTimeout(readTimer.current);
    setQuiet(false);
    setReadFailed(false);
    setChecking(false);
    const quietTimer = active
      ? setTimeout(() => {
          setQuiet(true);
          void refresh();
        }, LAUNCH_PROGRESS_QUIET_MS)
      : null;
    const reconcile = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    if (active) {
      window.addEventListener('online', reconcile);
      document.addEventListener('visibilitychange', reconcile);
    }
    return () => {
      epoch.current++;
      controller.current?.abort();
      if (quietTimer) clearTimeout(quietTimer);
      if (readTimer.current) clearTimeout(readTimer.current);
      window.removeEventListener('online', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, [active, evidence, refresh]);
  return { quiet, checking, readFailed, refresh };
}
