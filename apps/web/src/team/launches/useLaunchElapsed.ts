import { useEffect, useRef, useState } from 'react';
import type { LaunchGeneration } from '@video-compressor/shared';
import { privateCacheActor } from '../private-cache-scope';

type Clock = {
  id: string | null;
  attempt: number;
  started: number;
  stopped: number | null;
};

const PREFIX = 'soty:launch-elapsed:';
// A clock outlives its tab: a launch reopened in a new tab or window kept
// counting from 00:00 while its generation had run for minutes (1.4.3). When
// the server sends the attempt's start, that is the anchor; otherwise this
// device's first sight is.
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;

function readClock(key: string): Clock | null {
  return JSON.parse(localStorage.getItem(key) ?? 'null') as Clock | null;
}

function writeClock(key: string, clock: Clock) {
  localStorage.setItem(key, JSON.stringify(clock));
  const cutoff = Date.now() - KEEP_MS;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const other = localStorage.key(index);
    if (!other?.startsWith(PREFIX) || other === key) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(other) ?? 'null') as Clock | null;
      if (!saved || !Number.isFinite(saved.started) || saved.started < cutoff)
        localStorage.removeItem(other);
    } catch {
      localStorage.removeItem(other);
    }
  }
}

/** One clock per generation attempt, independent of stages and child identity. */
export function useLaunchElapsed(
  scope: string,
  generation: LaunchGeneration | null,
  pending: boolean,
  active: boolean
) {
  const key = `${PREFIX}${privateCacheActor() ?? ''}:${scope}`;
  const clock = useRef<Clock | null>(null);
  const wasPending = useRef(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const id = generation?.id ?? null;
  const attempt = generation?.attemptNo ?? 1;
  const parsedStart = generation?.startedAt ? Date.parse(generation.startedAt) : NaN;
  const serverStart = Number.isFinite(parsedStart) ? parsedStart : null;
  useEffect(() => {
    if (!clock.current) {
      try {
        const saved = readClock(key);
        if (
          saved &&
          saved.id === id &&
          saved.attempt === attempt &&
          Number.isFinite(saved.started) &&
          saved.started <= Date.now() &&
          (saved.stopped === null ||
            (Number.isFinite(saved.stopped) && saved.stopped >= saved.started))
        )
          clock.current = saved;
      } catch {
        /* Storage is optional; the live clock still works. */
      }
    }
    let current = clock.current;
    const starting = pending && !wasPending.current;
    const replaced =
      current &&
      id &&
      current.id &&
      (id !== current.id || attempt !== current.attempt) &&
      !wasPending.current;
    if (starting || replaced || (!current && active))
      current = { id, attempt, started: Date.now(), stopped: null };
    wasPending.current = pending;
    if (!current) return;
    if (id) {
      current.id = id;
      current.attempt = attempt;
    }
    // The server knows when this attempt really began: a reopened launch showed
    // 00:31 for a generation that had run for seven minutes (1.4.3 QA).
    if (serverStart !== null && id && current.id === id)
      current.started = Math.min(serverStart, current.stopped ?? Date.now());
    if (!active && current.stopped === null) current.stopped = Date.now();
    clock.current = current;
    try {
      writeClock(key, current);
    } catch {
      /* Optional persistence. */
    }
    const update = () =>
      setElapsed(
        Math.max(0, Math.floor(((current.stopped ?? Date.now()) - current.started) / 1000))
      );
    update();
    if (!active) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [key, id, attempt, pending, active, serverStart]);
  if (elapsed === null) return null;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
