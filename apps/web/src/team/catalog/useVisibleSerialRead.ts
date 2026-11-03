import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createReadCoordinator } from '../readCoordinator';

/** Debounced, scope-owned reads; hidden tabs catch up once on return. */
export function useVisibleSerialRead<T = void>({
  scopeKey,
  client,
  revision,
  debounceMs = 0,
  manualWhenHidden = false,
  bindScope = false,
  immediate = false,
  read
}: {
  scopeKey: string;
  client: unknown;
  revision: number;
  debounceMs?: number;
  manualWhenHidden?: boolean;
  bindScope?: boolean;
  immediate?: boolean;
  read: (signal: AbortSignal, deferFresh: () => void) => Promise<T>;
}) {
  const binding = useMemo(() => ({}), [scopeKey, client]);
  const boundBinding = bindScope ? binding : null;
  const readRef = useRef(read);
  readRef.current = read;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const observedRevision = useRef(revision);
  const owner = useRef<{
    binding: object;
    schedule: () => void;
    request: () => Promise<T | undefined>;
  } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const coordinator: ReturnType<typeof createReadCoordinator<T | undefined>> =
      createReadCoordinator<T | undefined>(async signal => {
        if (manualWhenHidden || document.visibilityState !== 'hidden')
          return readRef.current(signal, () => {
            if (coordinator.hasFreshRequests() || document.visibilityState !== 'hidden')
              coordinator.deferFresh();
          });
      });
    const invalidate = () => {
      if (document.visibilityState === 'hidden') return Promise.resolve();
      if (timer !== null) clearTimeout(timer);
      if (immediate)
        return coordinator.request().then(
          () => {},
          () => {}
        );
      timer = setTimeout(() => {
        timer = null;
        void coordinator.request().catch(() => {});
      }, debounceMs);
      return Promise.resolve();
    };
    owner.current = {
      binding,
      schedule: () => void invalidate(),
      request: () => {
        if (!manualWhenHidden && document.visibilityState === 'hidden')
          return Promise.resolve(undefined);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return coordinator.requestFresh();
      }
    };
    const visibility = () => {
      if (document.visibilityState !== 'hidden') void invalidate();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener('visibilitychange', visibility);
    observedRevision.current = currentRevision.current;
    void invalidate();
    return () => {
      coordinator.stop();
      owner.current = null;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [client, debounceMs, scopeKey, manualWhenHidden, immediate, binding]);
  useEffect(() => {
    if (observedRevision.current === revision) return;
    observedRevision.current = revision;
    owner.current?.schedule();
  }, [revision]);
  return useCallback(() => {
    const current = owner.current;
    if (!current || (boundBinding && current.binding !== boundBinding))
      return Promise.resolve(undefined);
    return current.request();
  }, [boundBinding]);
}
