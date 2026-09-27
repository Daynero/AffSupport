import { createContext, useCallback, useContext, useEffect, useId } from 'react';

type ReadState = 'pending' | 'fresh' | 'failed';

/** Local acknowledgement of authoritative reads; no network or recurring timers. */
export class CatalogFreshness {
  private readers = new Map<string, { teamId: string; token: number; state: ReadState }>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  private changed() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
  register(id: string, teamId: string) {
    const reader = { teamId, token: 0, state: 'pending' as ReadState };
    this.readers.set(id, reader);
    this.changed();
    return () => {
      if (this.readers.get(id) !== reader) return;
      this.readers.delete(id);
      this.changed();
    };
  }
  invalidate(teamId: string) {
    for (const reader of this.readers.values()) {
      if (reader.teamId !== teamId) continue;
      reader.token += 1;
      reader.state = 'pending';
    }
    this.changed();
  }
  isFresh(teamId: string) {
    return [...this.readers.values()].every(
      reader => reader.teamId !== teamId || reader.state === 'fresh'
    );
  }
  begin(id: string) {
    const reader = this.readers.get(id);
    if (!reader) return { succeed() {}, fail() {} };
    const token = ++reader.token;
    reader.state = 'pending';
    this.changed();
    const finish = (state: ReadState) => {
      if (this.readers.get(id) !== reader || reader.token !== token) return;
      reader.state = state;
      this.changed();
    };
    return { succeed: () => finish('fresh'), fail: () => finish('failed') };
  }
}

export const CatalogFreshnessContext = createContext<CatalogFreshness | null>(null);

export function useCatalogRead(teamId: string, enabled = true) {
  const freshness = useContext(CatalogFreshnessContext);
  const id = useId();
  useEffect(
    () => (enabled ? freshness?.register(id, teamId) : undefined),
    [enabled, freshness, id, teamId]
  );
  return useCallback(() => freshness?.begin(id) ?? { succeed() {}, fail() {} }, [freshness, id]);
}
