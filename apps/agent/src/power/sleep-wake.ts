/**
 * Notices that the machine was suspended and has resumed (FR-009a).
 *
 * Why clocks rather than an operating-system event: the agent is a plain Node process on
 * both targets. Node has no power notification of its own — Electron's `powerMonitor` is not
 * available here — and subscribing natively would mean an IOKit helper on macOS and a hidden
 * window pumping `WM_POWERBROADCAST` on Windows, two pieces of platform code to keep alive for
 * a signal that is only ever acted on a few seconds late anyway. What every platform does
 * share is that a suspend freezes this process along with everything else, and the clocks
 * show it. Two readings, either of which counts:
 *
 * - **Drift.** The wall clock keeps counting through a suspend; Node's monotonic clock
 *   (`performance.now()`, `mach_absolute_time` / `CLOCK_UPTIME_RAW` on Apple Silicon) does
 *   not. So wall time running ahead of monotonic time is a suspend and nothing else — an
 *   event loop that is merely late advances both alike, so even a machine held at a 20%
 *   limit, or throttled by App Nap, is never mistaken for one. This is the precise reading,
 *   and it catches short sleeps too.
 * - **Gap.** On Windows the monotonic clock (`QueryPerformanceCounter`) may keep counting
 *   across a suspend, so drift can read zero there. What still holds is that the probe's
 *   own timer could not fire while the machine was away: far more time gone than its period
 *   means it was suspended. The threshold is generous so that lateness is not read as sleep.
 *
 * A false positive costs a rebuilt duty cycle and a liveness check on whatever is running;
 * a missed wake can leave a run presented as going while nothing is. The detector errs
 * towards the first. A wall clock moved backwards (a manual change, NTP) reads as negative
 * drift and is ignored.
 */

export interface WakeEvent {
  /** Roughly how long the machine was away, as far as the wall clock can tell. */
  sleptMs: number;
  /** Which reading caught it; diagnostic only. */
  reading: 'drift' | 'gap';
}

export interface SleepWakeClocks {
  /** Keeps counting through a suspend. */
  wall: () => number;
  /** Stops during a suspend on macOS; may or may not on Windows. */
  monotonic: () => number;
}

export interface SleepWakeDetectorOptions {
  /** How often the probe looks. */
  periodMs: number;
  /** Wall time beyond the period, with monotonic time not keeping up, that means a suspend. */
  driftMs: number;
  /** Wall time beyond the period that means a suspend however the monotonic clock behaved. */
  gapMs: number;
  onWake: (event: WakeEvent) => void;
  /** Injectable for tests; defaults to `Date.now` and `performance.now`. */
  clocks?: SleepWakeClocks;
}

const defaultClocks: SleepWakeClocks = {
  wall: () => Date.now(),
  monotonic: () => performance.now()
};

/**
 * Classifies one probe interval. Pure, so the decision can be tested without timers.
 *
 * `wallElapsed` and `monotonicElapsed` are the time since the previous probe on each clock.
 */
export function classifyProbeInterval(
  wallElapsed: number,
  monotonicElapsed: number,
  options: Pick<SleepWakeDetectorOptions, 'periodMs' | 'driftMs' | 'gapMs'>
): WakeEvent | null {
  const drift = wallElapsed - monotonicElapsed;
  if (drift >= options.driftMs) return { sleptMs: Math.round(drift), reading: 'drift' };
  if (wallElapsed >= options.periodMs + options.gapMs) {
    return { sleptMs: Math.round(Math.max(0, wallElapsed - options.periodMs)), reading: 'gap' };
  }
  return null;
}

export class SleepWakeDetector {
  private readonly options: SleepWakeDetectorOptions;
  private readonly clocks: SleepWakeClocks;
  private timer: NodeJS.Timeout | null = null;
  private lastWall = 0;
  private lastMonotonic = 0;

  constructor(options: SleepWakeDetectorOptions) {
    this.options = options;
    this.clocks = options.clocks ?? defaultClocks;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.mark();
    const timer = setInterval(() => this.probe(), this.options.periodMs);
    // Never hold the process open to watch for a wake.
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the clocks. Public so the governor and tests can probe on demand. */
  probe(): void {
    const wall = this.clocks.wall();
    const monotonic = this.clocks.monotonic();
    const event = classifyProbeInterval(
      wall - this.lastWall,
      monotonic - this.lastMonotonic,
      this.options
    );
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    // Re-based before the listener runs, so a listener that takes its time — or throws — is
    // never itself read as the next suspend.
    if (event) this.options.onWake(event);
  }

  private mark(): void {
    this.lastWall = this.clocks.wall();
    this.lastMonotonic = this.clocks.monotonic();
  }
}
