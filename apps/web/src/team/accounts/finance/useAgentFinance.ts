import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceField, FinanceSnapshot } from '@video-compressor/shared';
import { teamFinanceApi } from '../../../api/team-finance';

/** One snapshot per period; realtime is owned by useAccounts, never another channel. */
export function useAgentFinance(
  teamId: string,
  from: string,
  to: string,
  timezone: string,
  revision: number,
  enabled = true,
  v2 = false,
  scopeKey = ''
) {
  const scope = JSON.stringify([teamId, timezone, enabled, v2, scopeKey]);
  const lifetime = useRef({ scope, epoch: 0, generation: 0, mounted: true, revision });
  const cache = useRef(new Map<string, FinanceSnapshot>());
  const reads = useRef(new Map<string, Promise<FinanceSnapshot | null>>());
  const [stored, setStored] = useState<{
    scope: string;
    epoch: number;
    snapshot: FinanceSnapshot | null;
  }>({
    scope,
    epoch: 0,
    snapshot: null
  });
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // Fence promises during render, before effects can expose a previous workspace
  // or permission lifetime. Period changes deliberately retain the small cache.
  if (lifetime.current.scope !== scope || (v2 && lifetime.current.revision !== revision)) {
    if (lifetime.current.scope !== scope) lifetime.current.epoch++;
    lifetime.current.scope = scope;
    lifetime.current.revision = revision;
    lifetime.current.generation++;
    cache.current.clear();
    reads.current.clear();
  }
  const setSnapshot = useCallback(
    (value: FinanceSnapshot | null | ((old: FinanceSnapshot | null) => FinanceSnapshot | null)) => {
      const currentScope = lifetime.current.scope;
      const currentEpoch = lifetime.current.epoch;
      setStored(old => ({
        scope: currentScope,
        epoch: currentEpoch,
        snapshot:
          typeof value === 'function'
            ? value(old.scope === currentScope && old.epoch === currentEpoch ? old.snapshot : null)
            : value
      }));
    },
    []
  );
  const preparedForPeriod =
    enabled && v2 ? cache.current.get(JSON.stringify([from, to])) : undefined;
  const snapshot =
    preparedForPeriod ??
    (stored.scope === scope &&
    stored.epoch === lifetime.current.epoch &&
    enabled &&
    (!v2 || (stored.snapshot?.from === from && stored.snapshot?.to === to))
      ? stored.snapshot
      : null);
  const remember = useCallback((result: FinanceSnapshot) => {
    const key = JSON.stringify([result.from, result.to]);
    cache.current.delete(key);
    cache.current.set(key, result);
    while (cache.current.size > 3) cache.current.delete(cache.current.keys().next().value!);
  }, []);
  const preparePeriod = useCallback(
    async (nextFrom: string, nextTo: string): Promise<FinanceSnapshot | null> => {
      if (!enabled || !v2 || !lifetime.current.mounted || lifetime.current.scope !== scope)
        return null;
      const key = JSON.stringify([nextFrom, nextTo]);
      const cached = cache.current.get(key);
      if (cached) return cached;
      const pending = reads.current.get(key);
      if (pending) return pending;
      const generation = lifetime.current.generation;
      const request = teamFinanceApi
        .snapshot(teamId, nextFrom, nextTo, timezone, true)
        .then(result => {
          if (
            !lifetime.current.mounted ||
            lifetime.current.scope !== scope ||
            lifetime.current.generation !== generation
          )
            return null;
          if (
            result.teamId !== teamId ||
            result.from !== nextFrom ||
            result.to !== nextTo ||
            (result.timezone !== undefined && result.timezone !== timezone)
          )
            throw new Error('INVALID_RESPONSE');
          remember(result);
          return result;
        });
      reads.current.set(key, request);
      try {
        return await request;
      } catch (cause) {
        if (
          lifetime.current.scope === scope &&
          lifetime.current.generation === generation &&
          cause instanceof Error &&
          /PERMISSION_DENIED|NOT_A_MEMBER|AUTH_REQUIRED/u.test(cause.message)
        ) {
          lifetime.current.generation++;
          cache.current.clear();
          reads.current.clear();
          setSnapshot(null);
          setError(cause);
          setLoading(false);
        }
        throw cause;
      } finally {
        if (reads.current.get(key) === request) reads.current.delete(key);
      }
    },
    [enabled, v2, scope, teamId, timezone, remember, setSnapshot]
  );
  const presentPrepared = useCallback(
    (result: FinanceSnapshot): boolean => {
      if (
        !enabled ||
        !v2 ||
        !lifetime.current.mounted ||
        lifetime.current.scope !== scope ||
        cache.current.get(JSON.stringify([result.from, result.to])) !== result
      )
        return false;
      // Selection commits in the owner immediately after this check. The next
      // render reads the exact prepared cache entry synchronously; do not change
      // the currently selected day's visible snapshot before that commit.
      return true;
    },
    [enabled, v2, scope]
  );
  useEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.generation++;
      cache.current.clear();
      reads.current.clear();
    };
  }, []);
  const trigger = useRef<() => void>(() => {});
  const mutations = useRef(0);
  const lastRevision = useRef(revision);
  const refresh = useCallback(() => trigger.current(), []);
  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    let active = true;
    const epoch = lifetime.current.epoch;
    const isCurrent = () => active && lifetime.current.epoch === epoch;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prepared = v2 ? cache.current.get(JSON.stringify([from, to])) : undefined;
    if (prepared) setSnapshot(prepared);
    else setSnapshot(null);
    setLoading(!prepared);
    setError(null);
    const read = async () => {
      if (!isCurrent()) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      const generation = mutations.current;
      try {
        const result = v2
          ? await preparePeriod(from, to)
          : await teamFinanceApi.snapshot(teamId, from, to, timezone, false);
        if (isCurrent() && result && generation === mutations.current) {
          setSnapshot(result);
          setError(null);
        } else if (isCurrent()) dirty = true;
      } catch (cause) {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause : new Error('INVALID_RESPONSE'));
          if (
            cause instanceof Error &&
            /PERMISSION_DENIED|NOT_A_MEMBER|AUTH_REQUIRED/u.test(cause.message)
          ) {
            lifetime.current.generation++;
            cache.current.clear();
            reads.current.clear();
            setSnapshot(null);
          }
        }
      } finally {
        running = false;
        if (isCurrent()) {
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
      if (!isCurrent()) return;
      if (v2) {
        lifetime.current.generation++;
        cache.current.clear();
        reads.current.clear();
      }
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
    if (!prepared) void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      trigger.current = () => {};
      window.removeEventListener('soty:accounts-finance', changed);
      window.removeEventListener('online', schedule);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [teamId, from, to, timezone, enabled, v2, scope, preparePeriod, setSnapshot]);
  // A space revision invalidates the data, not the period or its editors.
  // Resetting snapshot here unmounted every field and silently lost drafts.
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    refresh();
  }, [revision, refresh]);
  const applyFields = useCallback(
    (fields: readonly FinanceField[]) => {
      mutations.current += 1;
      lifetime.current.generation++;
      cache.current.clear();
      reads.current.clear();
      setSnapshot(old => {
        if (!old) return old;
        const incoming = fields.filter(field => field.date >= old.from && field.date <= old.to);
        return {
          ...old,
          fields: [
            ...old.fields.filter(
              field =>
                !incoming.some(
                  next =>
                    next.agentRowId === field.agentRowId &&
                    next.date === field.date &&
                    next.metric === field.metric
                )
            ),
            ...incoming
          ]
        };
      });
    },
    [setSnapshot]
  );
  return {
    snapshot,
    error,
    loading: preparedForPeriod ? false : loading,
    refresh,
    applyFields,
    preparePeriod,
    presentPrepared
  };
}
