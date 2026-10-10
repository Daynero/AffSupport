import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SpaceAccess } from '@video-compressor/shared';
import { SPACE_ACCESS_RECHECK_EVENT, fallbackSpaceAccess } from '../../api/team';

/**
 * Whether this person may be in a space, and what to tell them (034, R10).
 *
 * One question to the server — `get_my_space_access` — answered again:
 *   - every 5 s while the showcase or the paused screen is up, because those are
 *     the screens a grant or a renewal has to replace without a reload (SC-001);
 *   - when the tab comes back into focus;
 *   - when any team call is refused (`PERMISSION_DENIED`, `SPACE_BLOCKED`), which
 *     is how an open space learns it was just paused (FR-018).
 *
 * The page never decides access itself (FR-016). If the new RPC is not there —
 * an older database, a failed call — the old yes/no question stands in for it,
 * so the page degrades to what it did before tariffs rather than locking anyone
 * out.
 */

export const SPACE_ACCESS_POLL_MS = 5_000;
/** A burst of refusals is one question, not twenty. */
const RECHECK_THROTTLE_MS = 2_000;

export interface SpaceAccessClient {
  getMySpaceAccess: () => Promise<SpaceAccess>;
  /** The pre-tariff question, used only when the one above cannot be answered. */
  canAccessTeamWorkspace?: () => Promise<boolean>;
}

export interface SpaceAccessState {
  access: SpaceAccess | null;
  status: 'idle' | 'loading' | 'ready';
  /** Ask again now. */
  recheck: () => void;
}

export { fallbackSpaceAccess };

export function useSpaceAccess({
  client,
  enabled,
  poll
}: {
  client: SpaceAccessClient;
  enabled: boolean;
  poll: boolean;
}): SpaceAccessState {
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [status, setStatus] = useState<SpaceAccessState['status']>(enabled ? 'loading' : 'idle');
  const live = useRef({ client, access });
  live.current = { client, access };
  const inFlight = useRef<Promise<void> | null>(null);
  const lastAsked = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    lastAsked.current = Date.now();
    const run = (async () => {
      const { client: current } = live.current;
      let next: SpaceAccess;
      try {
        next = await current.getMySpaceAccess();
      } catch {
        // Keep an answer already on screen: one failed poll is not news.
        if (live.current.access) next = live.current.access;
        else if (current.canAccessTeamWorkspace) {
          next = fallbackSpaceAccess(await current.canAccessTeamWorkspace().catch(() => false));
        } else {
          next = fallbackSpaceAccess(false);
        }
      }
      if (!mounted.current) return;
      setAccess(next);
      setStatus('ready');
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = run;
    return run;
  }, []);

  const recheck = useCallback(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    void load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !poll) return;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load();
    }, SPACE_ACCESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, load, poll]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      void load();
    };
    const onRefused = () => {
      if (Date.now() - lastAsked.current < RECHECK_THROTTLE_MS) return;
      void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener(SPACE_ACCESS_RECHECK_EVENT, onRefused);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener(SPACE_ACCESS_RECHECK_EVENT, onRefused);
    };
  }, [enabled, load]);

  return { access: enabled ? access : null, status, recheck };
}

/**
 * The answer, shared below the team surface: the workspace's banner, the
 * renewal toast and the updater notice all read the same reply instead of
 * asking three times.
 */
export const SpaceAccessContext = createContext<SpaceAccessState | null>(null);

export function useOptionalSpaceAccess(): SpaceAccessState | null {
  return useContext(SpaceAccessContext);
}
