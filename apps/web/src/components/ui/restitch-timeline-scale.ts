/**
 * The length of a re-stitched video's final picture, as the timeline handles it (071).
 *
 * One range on a 0–60 minute scale: two handles, the near one the shortest length a video may
 * get, the far one the longest. Apart, every video draws its own length between them; together,
 * every video gets exactly that length. Whole minutes from 1 to 60 — the stitcher's own ceiling
 * (`STITCH_END_DURATION_MAX_SECONDS`) — so "40–50" is minutes, never seconds.
 */

export interface FinalDuration {
  /** Minutes, 1–60, never above `high`. */
  low: number;
  /** Minutes, 1–60, never below `low`. Equal to `low`: one exact length. */
  high: number;
}

export type FinalHandle = 'low' | 'high';

export const FINAL_MIN_MINUTES = 1;
export const FINAL_MAX_MINUTES = 60;

export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 45;
  return Math.min(FINAL_MAX_MINUTES, Math.max(FINAL_MIN_MINUTES, Math.round(minutes)));
}

export function exactDuration(duration: FinalDuration): boolean {
  return duration.low === duration.high;
}

/**
 * One handle moved to a minute. A handle pushed past the other carries it along, so two
 * handles together move as one exact length and can never cross.
 */
export function moveHandle(
  duration: FinalDuration,
  handle: FinalHandle,
  minutes: number
): FinalDuration {
  const value = clampMinutes(minutes);
  return handle === 'low'
    ? { low: value, high: Math.max(value, duration.high) }
    : { low: Math.min(value, duration.low), high: value };
}

/**
 * Where a drag lands: the handle's minute, except that a handle brought within a minute of the
 * other closes onto it — a one-minute range is a gap nobody aims for; an exact length is.
 */
export function dragHandle(
  duration: FinalDuration,
  handle: FinalHandle,
  minutes: number
): FinalDuration {
  const next = moveHandle(duration, handle, minutes);
  if (next.high - next.low !== 1) return next;
  return handle === 'low' ? { low: next.high, high: next.high } : { low: next.low, high: next.low };
}

/** The whole range slid by whole minutes, its width kept, inside 1–60. */
export function slideRange(start: FinalDuration, delta: number): FinalDuration {
  const bounded = Math.max(
    FINAL_MIN_MINUTES - start.low,
    Math.min(FINAL_MAX_MINUTES - start.high, Math.round(delta))
  );
  return { low: start.low + bounded, high: start.high + bounded };
}

const KEY_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 5,
  PageDown: -5
};

/** The keyboard's answer for one handle, or null for a key the slider does not own. */
export function durationAfterKey(
  duration: FinalDuration,
  handle: FinalHandle,
  key: string
): FinalDuration | null {
  const current = handle === 'low' ? duration.low : duration.high;
  if (key === 'Home') return moveHandle(duration, handle, FINAL_MIN_MINUTES);
  if (key === 'End') return moveHandle(duration, handle, FINAL_MAX_MINUTES);
  const step = KEY_STEPS[key];
  return step === undefined ? null : moveHandle(duration, handle, current + step);
}

/** "30–50" or "45" — the number a label wraps in its unit. */
export function spanText(duration: FinalDuration): string {
  return exactDuration(duration) ? String(duration.high) : `${duration.low}–${duration.high}`;
}

/** The ticks under the final picture's scale. */
export const FINAL_TICKS = [0, 10, 20, 30, 40, 50, 60] as const;
