import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { teamFinanceApi } from '../../../api/team-finance';

/** One snapshot per period; realtime is owned by useAccounts, never another channel. */
export function useAgentFinance(
  teamId: string,
  from: string,
  to: string,
  timezone: string,
  revision: number
) {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const trigger = useRef<() => void>(() => {});
  const lastRevision = useRef(revision);
  const refresh = useCallback(() => trigger.current(), []);
  useEffect(() => {
    let active = true;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    const read = async () => {
      if (!active) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        const result = await teamFinanceApi.snapshot(teamId, from, to, timezone);
        if (active) {
          setSnapshot(result);
          setError(null);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause : new Error('INVALID_RESPONSE'));
          if (
            cause instanceof Error &&
            /PERMISSION_DENIED|NOT_A_MEMBER|AUTH_REQUIRED/u.test(cause.message)
          )
            setSnapshot(null);
        }
      } finally {
        running = false;
        if (active) {
          setLoading(false);
          if (dirty) {
            dirty = false;
            timer = setTimeout(() => {
              timer = undefined;
              void read();
            }, 300);
          }
        }
      }
    };
    const schedule = () => {
      if (!active) return;
      if (running) {
        dirty = true;
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, 300);
    };
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === teamId) schedule();
    };
    const foreground = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    trigger.current = schedule;
    window.addEventListener('soty:accounts-finance', changed);
    window.addEventListener('online', schedule);
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      trigger.current = () => {};
      window.removeEventListener('soty:accounts-finance', changed);
      window.removeEventListener('online', schedule);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [teamId, from, to, timezone]);
  // A space revision invalidates the data, not the period or its editors.
  // Resetting snapshot here unmounted every field and silently lost drafts.
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    refresh();
  }, [revision, refresh]);
  return { snapshot, error, loading, refresh };
}
