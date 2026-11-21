/**
 * 064: one balance of чарунки for the whole page — the header, the assistant and both translation
 * places read the same number. The server is the authority: the store re-reads it on the Kyiv
 * midnight it reported, when the tab comes back, and after every paid action; it never counts by
 * itself. A sign-out or another account clears it (registerPrivateCache).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AiCreditsStatus } from '@video-compressor/shared';
import { creditsApi } from '../api/assistant';
import { registerPrivateCache } from '../team/private-cache-scope';

type State = { status: AiCreditsStatus | null; error: boolean };

let state: State = { status: null, error: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let watchers = 0;

function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const at = state.status ? Date.parse(state.status.resetsAt) : Number.NaN;
  if (!Number.isFinite(at) || watchers === 0) return;
  // One wake-up just after the reported reset; never a polling loop.
  const delay = Math.min(Math.max(at - Date.now() + 1_500, 1_000), 2 ** 31 - 1);
  timer = setTimeout(() => void refreshCredits(), delay);
}

export function setCredits(status: AiCreditsStatus | null) {
  if (!status) return;
  emit({ status, error: false });
  schedule();
}

export function refreshCredits(): Promise<void> {
  if (inflight) return inflight;
  inflight = creditsApi
    .status()
    .then(status => setCredits(status))
    .catch(() => emit({ ...state, error: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

registerPrivateCache(() => {
  if (timer) clearTimeout(timer);
  timer = null;
  emit({ status: null, error: false });
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The shared balance; the first reader starts the reads, the last one stops the timer. */
export function useCredits(enabled = true): State {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (!enabled) return;
    watchers++;
    if (!state.status) void refreshCredits();
    else schedule();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshCredits();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      watchers--;
      document.removeEventListener('visibilitychange', onVisible);
      if (watchers === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [enabled]);
  return snapshot;
}

/** «00:00» in Kyiv for the reported reset instant. */
export function kyivTime(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(
      new Date(iso)
    );
  } catch {
    return '00:00';
  }
}
