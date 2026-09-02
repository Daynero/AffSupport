/**
 * A progress figure that moves the way the work does.
 *
 * Whisper prints its position rarely and unevenly: nothing at all for the first stretch, then
 * a jump to twenty percent, then a few four-percent steps, then a long silence. Watching that,
 * there is no way to tell a run that is thinking from one that has hung, and no way to guess
 * how much longer it will be — which is the only question anyone asks of a progress bar.
 *
 * So the reported figure is smoothed between the real ones. Two rules make that honest rather
 * than decorative:
 *
 * - **It never goes backwards, and it never overtakes the truth.** An estimate is allowed to
 *   creep towards where the next real report is expected, and is stopped short of it. When the
 *   real report arrives it is adopted immediately, whether that is ahead of the estimate or
 *   behind where the estimate would have gone.
 * - **It only moves while the work does.** The rate comes from the run's own history — how
 *   much real progress arrived per second so far — so a run that stops producing reports also
 *   stops creeping, and a stall still looks like a stall instead of a bar that fills itself.
 *
 * The clock is injectable, so the behaviour is testable without waiting for it.
 */

/** How close to the projected next report an estimate may creep, as a fraction of the gap. */
const CREEP_CEILING = 0.9;
/** Below this the rate is noise, and creeping on it would be inventing movement. */
const MIN_RATE_PER_SECOND = 0.01;

export interface ProgressSmootherOptions {
  /** Where the smoothed figure goes. Called only when the value actually changed. */
  emit: (value: number) => void;
  now?: () => number;
  /** Rounding of the emitted figure; whole percent by default. */
  decimals?: number;
}

export class ProgressSmoother {
  readonly #emit: (value: number) => void;
  readonly #now: () => number;
  readonly #decimals: number;
  /** The last figure the work itself reported, and when. */
  #anchor = 0;
  #anchorAt: number;
  /** Real progress per second, learned from the run rather than assumed. */
  #ratePerSecond = 0;
  /** The end of the current phase; the estimate may creep towards it but never past it. */
  #ceiling = 100;
  /** What was last handed to `emit`; the figure never decreases below it. */
  #shown = 0;
  #started: number;

  constructor(options: ProgressSmootherOptions) {
    this.#emit = options.emit;
    this.#now = options.now ?? Date.now;
    this.#decimals = options.decimals ?? 0;
    this.#started = this.#now();
    this.#anchorAt = this.#started;
  }

  /**
   * Begins a phase of the run that moves at its own speed.
   *
   * Without this the rate learned while extracting audio — which finishes in a moment — was
   * carried into recognition, which takes minutes, and the bar shot to its ceiling in the
   * first second and sat there. The phases share nothing but the scale they report on.
   */
  startPhase(from: number, to: number, expectedSeconds: number | null = null): void {
    // A guess at how long the phase will take, so the bar moves before the first real report
    // arrives — recognition can be ten seconds silent at the start, which is precisely the
    // stretch where a still bar is read as a hang. Deliberately a slow guess: creeping under
    // the truth is corrected by the next report moving forward, while creeping over it would
    // have to be corrected by standing still.
    this.#ratePerSecond =
      expectedSeconds && expectedSeconds > 0 ? (to - from) / expectedSeconds : 0;
    this.#anchor = Math.max(this.#anchor, from);
    this.#anchorAt = this.#now();
    this.#ceiling = to;
    this.#publish(this.#anchor);
  }

  /** A figure the work actually reported. Adopted at once, and it teaches the rate. */
  report(value: number): void {
    const at = this.#now();
    const bounded = Math.min(100, Math.max(0, value));
    const elapsed = (at - this.#anchorAt) / 1_000;
    if (elapsed > 0 && bounded > this.#anchor) {
      const observed = (bounded - this.#anchor) / elapsed;
      // Averaged with what was already known, so one long gap between reports does not throw
      // the estimate away and one short one does not spike it.
      this.#ratePerSecond =
        this.#ratePerSecond > 0 ? (this.#ratePerSecond + observed) / 2 : observed;
    }
    this.#anchor = bounded;
    this.#anchorAt = at;
    this.#publish(bounded);
  }

  /** Called on a timer between reports; advances the estimate if there is reason to. */
  tick(): void {
    if (this.#ratePerSecond < MIN_RATE_PER_SECOND) return;
    const elapsed = (this.#now() - this.#anchorAt) / 1_000;
    if (elapsed <= 0) return;
    const projected = this.#anchor + this.#ratePerSecond * elapsed;
    // Creep towards where the next report is expected, never all the way to it: arriving
    // early and waiting is the thing that makes a bar look stuck.
    const towardsNext = this.#anchor + (projected - this.#anchor) * CREEP_CEILING;
    // Two ceilings, and the lower wins: short of the next expected report, and inside the
    // phase this belongs to. Neither may be crossed by an estimate.
    this.#publish(Math.min(towardsNext, this.#ceiling, 99));
  }

  /** The end of the run: the figure is whatever the caller says it is. */
  finish(value = 100): void {
    this.#anchor = value;
    this.#anchorAt = this.#now();
    this.#shown = value;
    this.#emit(this.#round(value));
  }

  #publish(value: number): void {
    // Monotonic on purpose. A bar that goes backwards reads as a failure even when the new
    // figure is the more accurate one.
    const next = Math.max(this.#shown, value);
    const rounded = this.#round(next);
    if (rounded === this.#round(this.#shown) && next !== 0) {
      this.#shown = next;
      return;
    }
    this.#shown = next;
    this.#emit(rounded);
  }

  #round(value: number): number {
    const factor = 10 ** this.#decimals;
    return Math.round(value * factor) / factor;
  }
}
