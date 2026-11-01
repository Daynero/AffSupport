import { useEffect, useRef, useState } from 'react';
import type { LaunchGeneration } from '@video-compressor/shared';

type Clock = {
  id: string | null;
  attempt: number;
  started: number;
  stopped: number | null;
};

/** One clock per generation attempt, independent of stages and child identity. */
export function useLaunchElapsed(
  scope: string,
  generation: LaunchGeneration | null,
  pending: boolean,
  active: boolean
) {
  const key = `soty:launch-elapsed:${scope}`;
  const clock = useRef<Clock | null>(null);
  const wasPending = useRef(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const id = generation?.id ?? null;
  const attempt = generation?.attemptNo ?? 1;
  useEffect(() => {
    if (!clock.current) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Clock | null;
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
    if (!active && current.stopped === null) current.stopped = Date.now();
    clock.current = current;
    try {
      sessionStorage.setItem(key, JSON.stringify(current));
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
  }, [key, id, attempt, pending, active]);
  if (elapsed === null) return null;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
