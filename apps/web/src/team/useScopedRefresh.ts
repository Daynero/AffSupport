import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { createReadCoordinator, withReadDeadline } from './readCoordinator';

/** Scope-owned, coalesced reads. Hidden tabs retain dirtiness and catch up once on return. */
export function useScopedRefresh<T>(input: {
  scope: string;
  load: (signal: AbortSignal) => Promise<T>;
  revision: number;
  source?: unknown;
  enabled?: boolean;
  intervalMs?: number;
}) {
  const { revision, enabled = true, intervalMs = 60_000 } = input;
  const actor = useOptionalAuth()?.user?.id ?? null;
  const scope = JSON.stringify([actor, input.scope]);
  const retryAfter = useRef(0);
  const failures = useRef(0);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const observedRevision = useRef(revision);
  const loadRef = useRef(input.load);
  loadRef.current = input.load;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    value: T;
    loadedAt: string;
  } | null>(null);
  const [retainedScope, setRetainedScope] = useState(scope);
  const [retainedSource, setRetainedSource] = useState(() => input.source);
  const [failure, setFailure] = useState<string | null>(null);
  if (retainedScope !== scope || retainedSource !== input.source) {
    setRetainedScope(scope);
    setRetainedSource(() => input.source);
    setSnapshot(null);
    setFailure(null);
  }
  const owner = useRef<ReturnType<typeof createReadCoordinator> | null>(null);
  const request = useCallback((force = false) => {
    if (document.visibilityState === 'hidden' || (!force && Date.now() < retryAfter.current))
      return Promise.resolve();
    return owner.current?.request() ?? Promise.resolve();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    retryAfter.current = 0;
    failures.current = 0;
    const coordinator = createReadCoordinator(async signal => {
      try {
        const value = await withReadDeadline(child => loadRef.current(child), signal);
        if (!active || signal.aborted) return;
        setSnapshot({ scope, value, loadedAt: new Date().toISOString() });
        setFailure(null);
        failures.current = 0;
        retryAfter.current = 0;
      } catch {
        if (active && !signal.aborted) {
          setFailure(scope);
          failures.current += 1;
          retryAfter.current =
            Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures.current - 1, 6));
        }
      }
    });
    owner.current = coordinator;
    observedRevision.current = revisionRef.current;
    void request();
    const visible = () => {
      if (document.visibilityState !== 'hidden') void request(true);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      coordinator.stop();
      if (owner.current === coordinator) owner.current = null;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [scope, input.source, enabled, request]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void request(), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, request]);

  useEffect(() => {
    if (!enabled || revision === observedRevision.current) return;
    observedRevision.current = revision;
    void request();
  }, [enabled, revision, request]);

  const reload = useCallback(() => request(true), [request]);
  return {
    value: enabled && snapshot?.scope === scope ? snapshot.value : null,
    error: enabled && failure === scope,
    lastLoadedAt: snapshot?.scope === scope ? snapshot.loadedAt : null,
    reload,
    poll: request
  };
}
