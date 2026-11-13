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
  const clockKey = useRef(key);
  const wasPending = useRef(false);
  const retryStarted = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const id = generation?.id ?? null;
  const attempt = generation?.attemptNo ?? 1;
  const state = generation?.state;
  const parsedStart = generation?.startedAt ? Date.parse(generation.startedAt) : NaN;
  const serverStart = Number.isFinite(parsedStart) ? parsedStart : null;
  useEffect(() => {
    if (clockKey.current !== key) {
      // Saving a new draft replaces its temporary route with the assigned ID.
      // Only that same actor/team transition may carry the provisional clock.
      const adoptingDraft =
        clock.current?.id === null &&
        id !== null &&
        clockKey.current.endsWith(':new') &&
        clockKey.current.slice(0, -3) === key.slice(0, key.lastIndexOf(':') + 1);
      if (!adoptingDraft) clock.current = null;
      clockKey.current = key;
      wasPending.current = false;
      retryStarted.current = null;
    }
    // A reconnect can briefly remove the generation projection. Do not replace
    // its durable local clock with an anonymous 00:00 while waiting for the read.
    if (!id && !pending) {
      if (!clock.current) setElapsed(null);
      return;
    }
    const savedClock = () => {
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
          return saved;
      } catch {
        /* Storage is optional; the authoritative attempt start still works. */
      }
      return null;
    };
    let current = clock.current ?? savedClock();
    if (pending && !wasPending.current && current?.stopped !== null && current)
      retryStarted.current = Date.now();
    wasPending.current = pending;
    const replaced =
      current && id && current.id && (current.id !== id || current.attempt !== attempt);
    if (replaced)
      current = savedClock() ?? {
        id,
        attempt,
        started: retryStarted.current ?? Date.now(),
        stopped: null
      };
    if (!current && active) current = { id, attempt, started: Date.now(), stopped: null };
    if (!current) {
      setElapsed(null);
      return;
    }
    if (id) {
      current.id = id;
      current.attempt = attempt;
    }
    if (replaced || !pending) retryStarted.current = null;
    // Acceptance may arrive after a long preparation. A later server timestamp
    // must not erase that time; an earlier one restores time missed by this tab.
    if (serverStart !== null && id)
      current.started = Math.min(current.started, serverStart, Date.now());
    const terminal = Boolean(
      state && ['failed', 'partial', 'interrupted', 'succeeded', 'canceled'].includes(state)
    );
    // Loss of observation is not the end of work. Freeze only a confirmed
    // terminal attempt; automatic recovery of that attempt resumes its clock.
    if (!active && terminal && current.stopped === null) current.stopped = Date.now();
    if (active && (!terminal || !pending)) current.stopped = null;
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
    if (!active || current.stopped !== null) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [key, id, attempt, state, pending, active, serverStart]);
  if (elapsed === null) return null;
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
