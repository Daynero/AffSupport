/**
 * Frame metrics for the transition smoke test (058, FR-027, research R9).
 *
 * A transition is judged on the content area only, frame by frame:
 *
 * - **Dip** — the triangle excess `(d(start, f) + d(f, end)) / d(start, end)`.
 *   Any frame of a crossfade is a blend of start and end, so the two distances
 *   add up to the direct one and the excess stays near 1. A blank frame, the
 *   background flashing through or an unrelated placeholder is far from both
 *   ends at once, and the excess jumps. When start and end look alike (a
 *   section with the same frame) the denominator is floored, so a flash
 *   between two similar screens still counts.
 * - **Pop** — how much of all the change between consecutive frames happens
 *   in one of them. A crossfade or a fade-in spreads the change over a dozen
 *   frames; content that appears at once puts most of it into one frame, which
 *   is what reads as a jolt even when no frame is blank (058, beta feedback).
 * - **Settle** — the time from the trigger to the first frame after which
 *   every frame matches the end. A screen that keeps an old layer on top, or
 *   keeps shifting, settles late.
 *
 * Frames are luminance arrays of equal length (`lumaOf`), already cropped to
 * the content area.
 */

/** Mean absolute luminance difference, 0–255. */
export function distance(a, b) {
  if (a.length !== b.length) throw new Error('frames differ in size');
  if (a.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}

/**
 * Rec. 601 luma of an RGBA buffer, cropped to `rect` and sampled every
 * `step` pixels in both directions (enough to see a flash, cheap to compare).
 */
export function lumaOf(rgba, width, rect, step = 2) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x + rect.width));
  const height = Math.floor(rgba.length / 4 / width);
  const y1 = Math.min(height, Math.floor(rect.y + rect.height));
  const out = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const at = (y * width + x) * 4;
      out.push(0.299 * rgba[at] + 0.587 * rgba[at + 1] + 0.114 * rgba[at + 2]);
    }
  }
  return Float32Array.from(out);
}

/** @typedef {{ excess: number, same: number, floor: number, background: number, popShare: number, popStep: number }} Thresholds */

/** @type {Readonly<Thresholds>} */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /**
   * Above this a frame is an unrelated picture, not a blend of start and end.
   * Loose on purpose: a list skeleton filling in is off the straight path
   * without being a flash; the background test below is the sharp one.
   */
  excess: 3,
  /** Two frames closer than this (mean luma) are the same picture. */
  same: 1.5,
  /** Floor for d(start, end), so similar screens still expose a flash. */
  floor: 6,
  /**
   * The flash people see: a frame much closer to the bare background (the
   * honeycomb) than both the screen it left and the one it reached — content
   * gone, canvas showing through. Below this ratio of distances it failed.
   */
  background: 0.55,
  /**
   * One frame-to-frame step carrying more than this share of all the movement
   * is a cut, not a crossfade…
   */
  popShare: 0.5,
  /** …provided the step is visible at all (mean luma). */
  popStep: 4
});

/**
 * @param {{ start: Float32Array, end: Float32Array, frames: Array<{ at: number, luma: Float32Array }>, background?: Float32Array }} input
 *   `at` is milliseconds after the trigger; `background` is the content area
 *   with no content in it, when the caller could capture one.
 * @param {Readonly<Thresholds>} [thresholds]
 */
export function analyzeTransition(
  { start, end, frames, background },
  thresholds = DEFAULT_THRESHOLDS
) {
  const direct = Math.max(distance(start, end), thresholds.floor);
  /** @type {{ excess: number, at: number | null, index: number }} */
  let worst = { excess: 1, at: null, index: -1 };
  const perFrame = frames.map((frame, index) => {
    const excess = (distance(start, frame.luma) + distance(frame.luma, end)) / direct;
    if (excess > worst.excess) worst = { excess, at: frame.at, index };
    return { at: frame.at, excess, toEnd: distance(frame.luma, end) };
  });
  /** @type {{ ratio: number, at: number | null, index: number }} */
  let bare = { ratio: Infinity, at: null, index: -1 };
  if (background) {
    const reference = Math.max(
      Math.min(distance(start, background), distance(end, background)),
      thresholds.floor
    );
    frames.forEach((frame, index) => {
      const ratio = distance(frame.luma, background) / reference;
      if (ratio < bare.ratio) bare = { ratio, at: frame.at, index };
    });
  }
  const flashed = bare.ratio < thresholds.background;
  /** @type {{ step: number, at: number | null, index: number, gapMs: number }} */
  let largest = { step: 0, at: null, index: -1, gapMs: 0 };
  let travelled = 0;
  let previous = start;
  let previousAt = 0;
  frames.forEach((frame, index) => {
    const step = distance(previous, frame.luma);
    travelled += step;
    if (step > largest.step) largest = { step, at: frame.at, index, gapMs: frame.at - previousAt };
    previous = frame.luma;
    previousAt = frame.at;
  });
  const popShare = travelled > 0 ? largest.step / travelled : 0;
  const popped = largest.step > thresholds.popStep && popShare > thresholds.popShare;
  let settledAt = 0;
  for (let index = perFrame.length - 1; index >= 0; index -= 1) {
    if (perFrame[index].toEnd > thresholds.same) {
      settledAt = index + 1 < perFrame.length ? perFrame[index + 1].at : perFrame[index].at;
      break;
    }
  }
  return {
    frames: frames.length,
    direct: Math.round(direct * 100) / 100,
    worstExcess: Math.round(worst.excess * 100) / 100,
    worstAt: flashed ? bare.at : worst.at,
    worstIndex: flashed ? bare.index : worst.index,
    backgroundRatio: Number.isFinite(bare.ratio) ? Math.round(bare.ratio * 100) / 100 : null,
    flashed,
    settledMs: settledAt,
    dipped: flashed || worst.excess > thresholds.excess,
    largestStep: Math.round(largest.step * 100) / 100,
    largestStepAt: largest.at,
    largestStepIndex: largest.index,
    /** Time since the frame before it: a long gap is the recorder missing frames, not a cut. */
    largestStepGapMs: largest.gapMs,
    popShare: Math.round(popShare * 100) / 100,
    popped
  };
}
