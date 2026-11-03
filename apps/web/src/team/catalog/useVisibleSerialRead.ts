import { useCallback, useEffect, useRef } from 'react';
import { createReadCoordinator } from '../readCoordinator';

/** Debounced scope-owned search reads; hidden tabs catch up once on return. */
export function useVisibleSerialRead({
  scopeKey,
  client,
  revision,
  debounceMs = 0,
  read
}: {
  scopeKey: string;
  client: unknown;
  revision: number;
  debounceMs?: number;
  read: (signal: AbortSignal) => Promise<void>;
}) {
  const readRef = useRef(read);
  readRef.current = read;
  const owner = useRef<{ schedule: () => void; request: () => Promise<void> } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const coordinator = createReadCoordinator(async signal => {
      if (document.visibilityState !== 'hidden') await readRef.current(signal);
    });
    const invalidate = () => {
      if (document.visibilityState === 'hidden') return Promise.resolve();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void coordinator.request().catch(() => {});
      }, debounceMs);
      return Promise.resolve();
    };
    owner.current = {
      schedule: () => void invalidate(),
      request: () => {
        if (document.visibilityState === 'hidden') return Promise.resolve();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return coordinator.request();
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
    void invalidate();
    return () => {
      coordinator.stop();
      owner.current = null;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [client, debounceMs, scopeKey]);
  useEffect(() => {
    if (revision !== 0) owner.current?.schedule();
  }, [revision]);
  return useCallback(() => owner.current?.request() ?? Promise.resolve(), []);
}
