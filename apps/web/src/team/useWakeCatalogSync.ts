import { useEffect } from 'react';
import { wakeCatalogSync } from '../api/team';

/** At most one wake-up per space this often: the server only acts on an idle feed. */
export const CATALOG_SYNC_WAKE_INTERVAL_MS = 2 * 60_000;

const lastWake = new Map<string, number>();

/** Forgets earlier wake-ups (tests). */
export function resetCatalogSyncWakes(): void {
  lastWake.clear();
}

/**
 * While a space is open and on screen, an idle Drive feed is polled at once
 * instead of after its backoff: when the space opens and whenever the tab
 * becomes visible again.
 */
export function useWakeCatalogSync(
  teamId: string | null,
  wake: (teamId: string) => Promise<void> = wakeCatalogSync,
  now: () => number = Date.now
): void {
  useEffect(() => {
    if (!teamId) return;
    const poke = () => {
      if (document.visibilityState !== 'visible') return;
      const at = now();
      const last = lastWake.get(teamId);
      if (last !== undefined && at - last < CATALOG_SYNC_WAKE_INTERVAL_MS) return;
      lastWake.set(teamId, at);
      void wake(teamId).catch(() => undefined);
    };
    poke();
    document.addEventListener('visibilitychange', poke);
    return () => document.removeEventListener('visibilitychange', poke);
  }, [teamId, wake, now]);
}
