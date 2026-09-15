import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A space's view choices that survive a reload and a return (filters, sort, search).
 *
 * Kept per space in this browser, the way the explorer already remembers its view and sort: a
 * refresh that dropped a narrowed task board back to "everything" made the refresh cost the person
 * their place. Every read is validated — a stored value from an older build, another space's
 * member id, or a hand-edited entry falls back to the default instead of breaking the page.
 */

const PREFIX = 'soty.team-view.v1';

export function persistedViewKey(teamId: string, name: string): string {
  return `${PREFIX}:${teamId}:${name}`;
}

function read<T>(key: string, fallback: T, parse: (value: unknown) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the choice still applies to this page.
  }
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (value: unknown) => T | null,
  encode: (value: T) => unknown = value => value
): [T, (next: T | ((current: T) => T)) => void] {
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const encodeRef = useRef(encode);
  encodeRef.current = encode;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const [state, setState] = useState(() => read(key, fallback, parse));
  const loadedKey = useRef(key);

  // Another space is another set of choices.
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setState(read(key, fallbackRef.current, parseRef.current));
  }, [key]);

  const set = useCallback((next: T | ((current: T) => T)) => {
    setState(current => {
      const value = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      write(loadedKey.current, encodeRef.current(value));
      return value;
    });
  }, []);

  return [state, set];
}

/* Validators for the shapes the team sections keep. */

export function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): T | null =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? (value as T)
      : null;
}

export function stringList(max = 100) {
  return (value: unknown): string[] | null =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)
      ? (value as string[])
      : null;
}

export function boundedText(max = 200) {
  return (value: unknown): string | null =>
    typeof value === 'string' && value.length <= max ? value : null;
}
