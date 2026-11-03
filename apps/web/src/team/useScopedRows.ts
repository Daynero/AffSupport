import { useCallback, useEffect, useRef, useState } from 'react';

/** Postgres versions include microseconds; Date.parse alone drops their last three digits. */
export function isOlderRowVersion(next: { updatedAt?: string }, current: { updatedAt?: string }) {
  const incoming = Date.parse(next.updatedAt ?? '');
  const existing = Date.parse(current.updatedAt ?? '');
  if (!Number.isFinite(incoming) || !Number.isFinite(existing)) return false;
  if (incoming !== existing) return incoming < existing;
  const micros = (value: string) =>
    (value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6);
  return micros(next.updatedAt!) < micros(current.updatedAt!);
}

/** A bounded, identity-owned view cache and lifetime for protected row readers. */
export function useScopedRows<T>(
  identity: string,
  view: string,
  source: unknown,
  cacheEnabled: boolean
) {
  const owner = useRef({ source, epoch: 0 });
  if (owner.current.source !== source) owner.current = { source, epoch: owner.current.epoch + 1 };
  const lifetimeKey = JSON.stringify([identity, view, owner.current.epoch]);
  const cache = useRef(
    new Map<string, { rows: T[]; hasMore: boolean; expiresAt: number }>()
  ).current;
  const entry = cache.get(lifetimeKey);
  const cached = cacheEnabled && entry && entry.expiresAt > Date.now() ? entry : undefined;
  const [rows, setRows] = useState<T[]>(cached?.rows ?? []);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const [retained, setRetained] = useState({ identity, key: lifetimeKey });
  const generation = useRef(0);
  const writes = useRef(0);
  const reading = useRef(false);
  const lifetime = useRef({ key: lifetimeKey, active: true });
  lifetime.current = { key: lifetimeKey, active: true };
  if (retained.key !== lifetimeKey) {
    const sameIdentity = retained.identity === identity;
    if (!sameIdentity) cache.clear();
    generation.current += 1;
    setRetained({ identity, key: lifetimeKey });
    setRows(sameIdentity ? (cached?.rows ?? []) : []);
    setHasMore(sameIdentity ? (cached?.hasMore ?? false) : false);
    setLoading(!sameIdentity || cached === undefined);
    setError(null);
  }
  useEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
    };
  }, []);
  useEffect(() => {
    if (!cacheEnabled || loading) return;
    cache.set(lifetimeKey, { rows, hasMore, expiresAt: Date.now() + 60_000 });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
  }, [cache, cacheEnabled, hasMore, lifetimeKey, loading, rows]);
  const commit = useCallback(
    async <R>(work: () => Promise<R>, apply: (result: R) => void, refresh: () => Promise<void>) => {
      const current = () => lifetime.current.active && lifetime.current.key === lifetimeKey;
      if (!current()) throw new DOMException('Scope changed', 'AbortError');
      const result = await work();
      if (current()) {
        writes.current += 1;
        apply(result);
        if (reading.current) void refresh();
      }
      return result;
    },
    [lifetimeKey]
  );
  return {
    commit,
    rows,
    setRows,
    hasMore,
    setHasMore,
    loading,
    setLoading,
    error,
    setError,
    generation,
    writes,
    reading,
    lifetime,
    lifetimeKey,
    cached: cached !== undefined
  };
}
