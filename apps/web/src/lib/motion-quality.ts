/**
 * How smooth the last transitions actually were (058, FR-018, R8).
 *
 * Two browser signals, both optional: long animation frames (or long tasks
 * where that entry type is missing) while a transition runs, and layout shift
 * after it settles. Frames are counted from the moment the animation starts,
 * not from the render before it. A machine that dropped two or more long
 * frames in each of three animations in a row is put in `lite` mode for the rest of the session: page transitions
 * become instant swaps instead of stuttering crossfades. Section moves keep
 * their motion — they are the cheaper one and the one people make most.
 *
 * Nothing here throws when the browser lacks `PerformanceObserver` or an
 * entry type; the measurements then read zero and lite mode never arms.
 */

/** A frame longer than this is a frame someone can see stall. */
export const LONG_FRAME_MS = 50;
const LITE_AFTER_STUTTERS = 3;
/** Long frames within one animation that make it a stutter, not a hiccup. */
const STUTTER_LONG_FRAMES = 2;

interface Tally {
  longFrames: number;
  layoutShift: number;
}

let observing = false;
let lite = false;
let stutterStreak = 0;
const tallies = new Set<Tally>();

function supports(type: string): boolean {
  if (typeof PerformanceObserver === 'undefined') return false;
  const types = (PerformanceObserver as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes;
  return Array.isArray(types) && types.includes(type);
}

function observe(type: string, onEntry: (entry: PerformanceEntry) => void): boolean {
  if (!supports(type)) return false;
  try {
    new PerformanceObserver(list => list.getEntries().forEach(onEntry)).observe({
      type,
      buffered: false
    });
    return true;
  } catch {
    return false;
  }
}

function ensureObserving() {
  if (observing) return;
  observing = true;
  const onLongFrame = (entry: PerformanceEntry) => {
    if (entry.duration <= LONG_FRAME_MS) return;
    tallies.forEach(tally => (tally.longFrames += 1));
  };
  if (!observe('long-animation-frame', onLongFrame)) observe('longtask', onLongFrame);
  observe('layout-shift', entry => {
    const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (shift.hadRecentInput) return;
    tallies.forEach(tally => (tally.layoutShift += shift.value ?? 0));
  });
}

export interface MeasureWindow {
  /** Stops measuring and returns what was seen. Safe to call twice. */
  end(): { longFrames: number; layoutShift: number };
}

/** Starts counting long frames and layout shift until `end()`. */
export function beginMeasure(): MeasureWindow {
  ensureObserving();
  const tally: Tally = { longFrames: 0, layoutShift: 0 };
  tallies.add(tally);
  return {
    end() {
      tallies.delete(tally);
      return { longFrames: tally.longFrames, layoutShift: tally.layoutShift };
    }
  };
}

/**
 * Feeds the result of one animated transition into the lite-mode decision.
 * Instant swaps are not reported: they say nothing about animation cost.
 */
export function reportAnimatedTransition(longFrames: number) {
  stutterStreak = longFrames >= STUTTER_LONG_FRAMES ? stutterStreak + 1 : 0;
  if (stutterStreak >= LITE_AFTER_STUTTERS) lite = true;
}

export function isLiteMotion(): boolean {
  return lite;
}

/** Tests only. */
export function resetMotionQualityForTests() {
  lite = false;
  stutterStreak = 0;
  tallies.clear();
}
